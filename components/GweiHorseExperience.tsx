"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { ethers } from "ethers";
import type { Eip1193Provider } from "ethers";

type PendingTx = {
  hash: string;
  from: string;
  nonce: number;
  effectiveGasGwei: number;
};

type MineTx = {
  hash: string;
  from: string;
  nonce: number;
  valueWei: string;
  effectiveGasGwei: number | null;
};

type BetChoice = 0 | 1 | 2 | 3 | 99;

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

const TRACK_LENGTH = 80;
const LANE_WIDTH = 3.2;
const NUM_LANES = 8;
const TRACK_WIDTH = NUM_LANES * LANE_WIDTH;

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function formatHashShort(hash: string) {
  if (!hash) return "";
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function gasToColorHex(gwei: number) {
  // Map gas -> warm gold / green vibe.
  const t = clamp((gwei - 5) / 180, 0, 1);
  const color = new THREE.Color();
  // Hue from ~green to ~gold.
  color.setHSL(0.24 - t * 0.12, 0.72, 0.54);
  return color.getHex();
}

export default function GweiHorseExperience() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const mineTxRef = useRef<MineTx | null>(null);
  const walletAddressRef = useRef<string | null>(null);

  const betRef = useRef<{
    offset: BetChoice;
    targetBlockNumber: number;
    resolved: boolean;
  } | null>(null);

  const raceRef = useRef<{
    currentBlockNumber: number;
    raceTargetBlockNumber: number;
    secondsLeft: number;
    blockTimeSec: number;
    lastBlockTimestamp: number | null;
    mineConfirmed: boolean;
    mineConfirmedBlock: number | null;
  }>({
    currentBlockNumber: 0,
    raceTargetBlockNumber: 1,
    secondsLeft: 12,
    blockTimeSec: 12,
    lastBlockTimestamp: null,
    mineConfirmed: false,
    mineConfirmedBlock: null,
  });

  const pendingMapRef = useRef<Map<string, { tx: PendingTx; seenAt: number }>>(
    new Map()
  );
  const pendingBySenderNonceRef = useRef<Map<string, PendingTx>>(new Map());

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [txHashInput, setTxHashInput] = useState("");
  const [mineTx, setMineTx] = useState<MineTx | null>(null);
  const [activeBet, setActiveBet] = useState<BetChoice | null>(null);

  const horseLaneHues = useMemo(() => {
    const arr: number[] = [];
    for (let i = 0; i < NUM_LANES; i++) arr.push(i / NUM_LANES);
    return arr;
  }, []);

  useEffect(() => {
    mineTxRef.current = mineTx;
  }, [mineTx]);
  useEffect(() => {
    walletAddressRef.current = walletAddress;
  }, [walletAddress]);

  useEffect(() => {
    if (!containerRef.current) return;

    // ─── SCENE SETUP ────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0f);
    scene.fog = new THREE.FogExp2(0x0a0a0f, 0.018);

    const W = window.innerWidth;
    const H = window.innerHeight;
    const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 400);
    camera.position.set(0, 8, 22);
    camera.lookAt(0, 1, -10);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    containerRef.current.appendChild(renderer.domElement);

    // Lights
    const ambient = new THREE.AmbientLight(0xffeedd, 0.6);
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffcc88, 1.4);
    sun.position.set(10, 20, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 0.1;
    sun.shadow.camera.far = 100;
    sun.shadow.camera.left = -40;
    sun.shadow.camera.right = 40;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0x4488ff, 0.3);
    fill.position.set(-10, 5, -5);
    scene.add(fill);

    // Track
    const groundGeo = new THREE.PlaneGeometry(TRACK_WIDTH + 20, TRACK_LENGTH + 40);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x2a4a1a });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    scene.add(ground);

    const trackGeo = new THREE.PlaneGeometry(TRACK_WIDTH, TRACK_LENGTH);
    const trackMat = new THREE.MeshLambertMaterial({ color: 0x8b6914 });
    const track = new THREE.Mesh(trackGeo, trackMat);
    track.rotation.x = -Math.PI / 2;
    track.position.set(0, 0, 0);
    track.receiveShadow = true;
    scene.add(track);

    // Lane dividers
    for (let i = 0; i <= NUM_LANES; i++) {
      const x = -TRACK_WIDTH / 2 + i * LANE_WIDTH;
      const lineGeo = new THREE.PlaneGeometry(0.08, TRACK_LENGTH);
      const lineMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.25,
      });
      const line = new THREE.Mesh(lineGeo, lineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(x, 0.01, 0);
      scene.add(line);
    }

    // Finish line
    const finishGeo = new THREE.PlaneGeometry(TRACK_WIDTH, 1.2);
    const finishCanvas = document.createElement("canvas");
    finishCanvas.width = 512;
    finishCanvas.height = 64;
    const finishCtx = finishCanvas.getContext("2d");
    if (finishCtx) {
      for (let i = 0; i < 32; i++) {
        finishCtx.fillStyle = i % 2 === 0 ? "#ffffff" : "#111111";
        finishCtx.fillRect(i * 16, 0, 16, 32);
        finishCtx.fillStyle = i % 2 === 0 ? "#111111" : "#ffffff";
        finishCtx.fillRect(i * 16, 32, 16, 32);
      }
    }
    const finishTex = new THREE.CanvasTexture(finishCanvas);
    const finishMat = new THREE.MeshBasicMaterial({ map: finishTex });
    const finish = new THREE.Mesh(finishGeo, finishMat);
    finish.rotation.x = -Math.PI / 2;
    finish.position.set(0, 0.02, -TRACK_LENGTH / 2 + 2);
    scene.add(finish);

    // Start line
    const startGeo = new THREE.PlaneGeometry(TRACK_WIDTH, 0.5);
    const startMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
    });
    const startLine = new THREE.Mesh(startGeo, startMat);
    startLine.rotation.x = -Math.PI / 2;
    startLine.position.set(0, 0.02, TRACK_LENGTH / 2 - 2);
    scene.add(startLine);

    // Fences
    function makeFence(side: "left" | "right") {
      const xSign = side === "left" ? -1 : 1;
      const x = xSign * (TRACK_WIDTH / 2 + 0.8);
      for (let z = -TRACK_LENGTH / 2; z < TRACK_LENGTH / 2; z += 3) {
        const postGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.4, 6);
        const postMat = new THREE.MeshLambertMaterial({ color: 0xa07830 });
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(x, 0.7, z);
        post.castShadow = true;
        scene.add(post);
      }
      const railGeo = new THREE.CylinderGeometry(0.04, 0.04, TRACK_LENGTH, 6);
      const railMat = new THREE.MeshLambertMaterial({ color: 0xc89840 });
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.rotation.z = Math.PI / 2;
      rail.position.set(x, 1.0, 0);
      scene.add(rail);
      const rail2 = rail.clone();
      rail2.position.set(x, 0.5, 0);
      scene.add(rail2);
    }
    makeFence("left");
    makeFence("right");

    // Grandstands (suggestion boxes)
    for (let i = 0; i < 8; i++) {
      const geo = new THREE.BoxGeometry(2.5, 3 + Math.random() * 2, 3);
      const colors = [0x8b3a3a, 0x3a5a8b, 0x6b8b3a, 0x8b6b3a];
      const mat = new THREE.MeshLambertMaterial({ color: colors[i % 4] });
      const box = new THREE.Mesh(geo, mat);
      const side = i < 4 ? -1 : 1;
      box.position.set(
        side * (TRACK_WIDTH / 2 + 4 + (i % 4) * 2.8),
        1,
        -15 + (i % 4) * 8
      );
      scene.add(box);
    }

    // Trees
    function makeTree(x: number, z: number) {
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.2, 2, 6),
        new THREE.MeshLambertMaterial({ color: 0x5c3d2e })
      );
      trunk.position.set(x, 1, z);
      trunk.castShadow = true;
      scene.add(trunk);
      const foliage = new THREE.Mesh(
        new THREE.SphereGeometry(1.2, 7, 7),
        new THREE.MeshLambertMaterial({ color: 0x2d6a3f })
      );
      foliage.position.set(x, 3, z);
      foliage.castShadow = true;
      scene.add(foliage);
    }
    [-18, -14, -22, -26, 18, 14, 22, 26].forEach((x, i) =>
      makeTree(x, -20 + (i % 4) * 12)
    );

    // Crowd dots (simple spheres)
    for (let i = 0; i < 60; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const geo = new THREE.SphereGeometry(0.22, 6, 6);
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color().setHSL(Math.random(), 0.6, 0.5),
      });
      const person = new THREE.Mesh(geo, mat);
      person.position.set(
        side * (TRACK_WIDTH / 2 + 3 + Math.random() * 6),
        1.5 + Math.random() * 2,
        -TRACK_LENGTH / 2 + 5 + Math.random() * (TRACK_LENGTH * 0.7)
      );
      scene.add(person);
    }

    // Dust particles
    const dustGeo = new THREE.BufferGeometry();
    const dustCount = 200;
    const dustPositions = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i++) {
      dustPositions[i * 3] = (Math.random() - 0.5) * TRACK_WIDTH;
      dustPositions[i * 3 + 1] = Math.random() * 0.5;
      dustPositions[i * 3 + 2] = (Math.random() - 0.5) * TRACK_LENGTH;
    }
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
    const dustMat = new THREE.PointsMaterial({
      color: 0xc89840,
      size: 0.12,
      transparent: true,
      opacity: 0.4,
    });
    const dustParticles = new THREE.Points(dustGeo, dustMat);
    scene.add(dustParticles);

    // Sky + stars
    const skyGeo = new THREE.SphereGeometry(200, 16, 16);
    const skyMat = new THREE.MeshBasicMaterial({
      color: 0x0a0a2a,
      side: THREE.BackSide,
    });
    scene.add(new THREE.Mesh(skyGeo, skyMat));

    const starGeo = new THREE.BufferGeometry();
    const starCount = 400;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.6;
      starPos[i * 3] = 180 * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = 180 * Math.cos(phi) + 20;
      starPos[i * 3 + 2] = 180 * Math.sin(phi) * Math.sin(theta);
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.6,
      transparent: true,
      opacity: 0.8,
    });
    scene.add(new THREE.Points(starGeo, starMat));

    // ─── HORSES ─────────────────────────────────────────────────
    type HorseData = {
      txHash: string;
      gasGwei: number;
      from: string;
      nonce: number;
      isMine: boolean;
      color: number;
    };

    const horses: THREE.Group[] = [];
    let raceGasMax = 1;

    function createHorse(data: HorseData, laneIndex: number) {
      const group = new THREE.Group();
      const x = -TRACK_WIDTH / 2 + LANE_WIDTH / 2 + laneIndex * LANE_WIDTH;
      const z = TRACK_LENGTH / 2 - 3;
      group.position.set(x, 0, z);

      // Body
      const bodyGeo = new THREE.BoxGeometry(0.6, 0.55, 1.3);
      const bodyMat = new THREE.MeshLambertMaterial({ color: data.color });
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.position.y = 0.85;
      body.castShadow = true;
      group.add(body);

      // Head
      const headGeo = new THREE.BoxGeometry(0.35, 0.38, 0.5);
      const head = new THREE.Mesh(headGeo, bodyMat);
      head.position.set(0, 1.28, -0.68);
      head.rotation.x = -0.3;
      head.castShadow = true;
      group.add(head);

      // Neck
      const neckGeo = new THREE.BoxGeometry(0.22, 0.4, 0.28);
      const neck = new THREE.Mesh(neckGeo, bodyMat);
      neck.position.set(0, 1.12, -0.52);
      neck.rotation.x = -0.4;
      group.add(neck);

      // Legs
      const legPositions: Array<[number, number]> = [
        [-0.18, -0.15],
        [0.18, -0.15],
        [-0.18, 0.32],
        [0.18, 0.32],
      ];
      const legGeo = new THREE.BoxGeometry(0.12, 0.55, 0.12);
      const legMat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(data.color).multiplyScalar(0.75),
      });
      legPositions.forEach(([lx, lz]) => {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(lx, 0.36, lz);
        group.add(leg);
      });

      // Mane + tail
      const maneGeo = new THREE.BoxGeometry(0.12, 0.22, 0.5);
      const maneMat = new THREE.MeshLambertMaterial({ color: 0x3d2b1a });
      const mane = new THREE.Mesh(maneGeo, maneMat);
      mane.position.set(0, 1.32, -0.4);
      group.add(mane);

      const tailGeo = new THREE.BoxGeometry(0.1, 0.3, 0.12);
      const tail = new THREE.Mesh(tailGeo, maneMat);
      tail.position.set(0, 0.9, 0.66);
      tail.rotation.x = 0.4;
      group.add(tail);

      // Jockey
      const jockeyBody = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.32, 0.28),
        new THREE.MeshLambertMaterial({
          color: data.isMine
            ? 0xc9953a
            : new THREE.Color().setHSL(
                horseLaneHues[laneIndex],
                0.7,
                0.5
              ),
        })
      );
      jockeyBody.position.set(0, 1.35, -0.1);
      jockeyBody.castShadow = true;
      group.add(jockeyBody);

      const jockeyHead = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 7, 7),
        new THREE.MeshLambertMaterial({ color: 0xf5cba7 })
      );
      jockeyHead.position.set(0, 1.62, -0.1);
      group.add(jockeyHead);

      const helmet = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 7, 7),
        new THREE.MeshLambertMaterial({
          color: data.isMine ? 0xc9953a : 0x222222,
        })
      );
      helmet.position.set(0, 1.7, -0.1);
      helmet.scale.y = 0.7;
      group.add(helmet);

      if (data.isMine) {
        const glowGeo = new THREE.SphereGeometry(1.4, 8, 8);
        const glowMat = new THREE.MeshBasicMaterial({
          color: 0xc9953a,
          transparent: true,
          opacity: 0.08,
          wireframe: false,
        });
        const glow = new THREE.Mesh(glowGeo, glowMat);
        glow.position.y = 0.8;
        group.add(glow);
      }

      group.userData = {
        txHash: data.txHash,
        gasGwei: data.gasGwei,
        from: data.from,
        nonce: data.nonce,
        isMine: data.isMine,
        laneIndex,
        progress: 0,
        startZ: z,
        bobPhase: Math.random() * Math.PI * 2,
      };

      scene.add(group);
      return group;
    }

    function clearHorses() {
      while (horses.length > 0) {
        const h = horses.pop();
        if (!h) break;
        scene.remove(h);
        h.traverse((obj) => {
          if (!(obj instanceof THREE.Mesh)) return;
          obj.geometry.dispose?.();
          const mat = obj.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
          else mat.dispose?.();
        });
      }
    }

    function setHorsesForRace(horseDatas: HorseData[]) {
      clearHorses();
      const max = Math.max(1, ...horseDatas.map((d) => d.gasGwei));
      raceGasMax = max;

      for (let laneIndex = 0; laneIndex < NUM_LANES; laneIndex++) {
        const data = horseDatas[laneIndex] ?? {
          txHash: `filler-${laneIndex}`,
          gasGwei: 1,
          from: "0x0000000000000000000000000000000000000000",
          nonce: laneIndex,
          isMine: false,
          color: gasToColorHex(1),
        };
        horses.push(createHorse(data, laneIndex));
      }

      const el = document.getElementById("raceCount");
      if (el) el.textContent = `${horseDatas.filter(Boolean).length || 0} horses`;
    }

    // Initial horses
    setHorsesForRace(
      Array.from({ length: NUM_LANES }, (_, i) => ({
        txHash: `seed-${i}`,
        gasGwei: 40 + i * 3,
        from: "0x0000000000000000000000000000000000000000",
        nonce: i,
        isMine: false,
        color: gasToColorHex(40 + i * 3),
      }))
    );

    // ─── HUD HELPERS ─────────────────────────────────────────────
    let toastTimer: ReturnType<typeof setTimeout> | null = null;
    const showToast = (msg: string) => {
      const t = document.getElementById("toast");
      if (!t) return;
      t.textContent = msg;
      t.classList.add("show");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
    };

    const spawnConfetti = () => {
      const layer = document.getElementById("confLayer");
      if (!layer) return;
      const cols = ["#C9953A", "#F0C96A", "#52B788", "#4488ff", "#E86A4A"];
      for (let i = 0; i < 24; i++) {
        const p = document.createElement("div");
        p.className = "conf-p";
        p.style.left = `${Math.random() * 100}vw`;
        p.style.top = "-10px";
        p.style.background = cols[Math.floor(Math.random() * cols.length)];
        p.style.animationDelay = `${Math.random() * 0.5}s`;
        p.style.animationDuration = `${0.8 + Math.random() * 0.7}s`;
        layer.appendChild(p);
        setTimeout(() => p.remove(), 2000);
      }
    };

    // ─── RACE STATE UPDATERS ────────────────────────────────────
    let lastBoardUpdate = 0;
    let lastCountdownUpdate = 0;

    type HorseUserData = {
      txHash: string;
      gasGwei: number;
      from: string;
      nonce: number;
      isMine: boolean;
      laneIndex: number;
      progress: number;
      startZ: number;
      bobPhase: number;
    };

    const updateBoard = () => {
      const sorted = [...horses].sort(
        (a, b) =>
          (b.userData.progress as number) - (a.userData.progress as number)
      );
      const rows = document.getElementById("boardRows");
      if (!rows) return;
      rows.innerHTML = "";

      sorted.forEach((h, i) => {
        const d = h.userData as HorseUserData;
        const blockEst = i === 0 ? "now" : i < 3 ? "+1" : i < 5 ? "+2" : "late";
        const blockClass =
          blockEst === "now"
            ? "block-now"
            : blockEst === "+1"
            ? "block-1"
            : blockEst === "+2"
            ? "block-2"
            : "block-late";

        const row = document.createElement("div");
        row.className = "board-row" + (d.isMine ? " mine" : "");
        row.innerHTML = `
          <span class="board-pos">${i + 1}</span>
          <span class="board-name${d.isMine ? " mine" : ""}">${
            d.isMine ? "★ " : ""
          } ${Math.round(d.gasGwei)}g</span>
          <span class="board-gas">${Math.round(d.gasGwei)}<span style="font-size:9px;color:rgba(255,255,255,0.3)"> gwei</span></span>
          <span class="board-block ${blockClass}">${blockEst}</span>
        `;
        rows.appendChild(row);

        if (d.isMine) {
          const myRank = document.getElementById("myRank");
          if (myRank) myRank.textContent = "#" + (i + 1);
        }
      });
    };

    // Camera sway
    let camTime = 0;
    const clock = new THREE.Clock();
    let rafId: number | null = null;

    const updateHorsePositions = (dt: number) => {
      const raceState = raceRef.current;
      const startZ = TRACK_LENGTH / 2 - 3;
      const endZ = -TRACK_LENGTH / 2 + 3;

      for (const h of horses) {
        const d = h.userData as HorseUserData;
        const isMine = !!d.isMine;
        const confirmed = isMine && raceState.mineConfirmed;

        if (confirmed) {
          d.progress = 1;
          h.position.z = endZ;
          h.position.y = 0.1;
          h.rotation.z = 0;
          continue;
        }

        const gas = Math.max(0.1, d.gasGwei as number);
        const speed = (gas / Math.max(1, raceGasMax)) * 18 * dt;
        const jitter = (Math.random() - 0.5) * 2 * dt;
        d.progress = Math.min(1, d.progress + speed * 0.06 + jitter * 0.01);

        h.position.z = startZ + d.progress * (endZ - startZ);

        const bobSpeed = 4 + (gas / Math.max(1, raceGasMax)) * 10;
        d.bobPhase += dt * bobSpeed;
        h.position.y = Math.max(0, Math.sin(d.bobPhase) * 0.12);
        h.rotation.z = Math.sin(d.bobPhase * 0.5) * 0.04;
        h.rotation.x = -0.06;
      }
    };

    const animate = () => {
      rafId = requestAnimationFrame(animate);
      const dt = clock.getDelta();
      const elapsed = clock.getElapsedTime();

      // Camera gentle sway
      camTime += dt * 0.3;
      camera.position.x = Math.sin(camTime * 0.4) * 2;
      camera.position.y = 8 + Math.sin(camTime * 0.3) * 0.5;
      camera.lookAt(Math.sin(camTime * 0.2) * 1, 1.5, -8);

      updateHorsePositions(dt);

      // Dust drift
      const dp = dustGeo.attributes.position.array as Float32Array;
      for (let i = 0; i < dustCount; i++) {
        dp[i * 3 + 2] += dt * 2;
        dp[i * 3 + 1] = Math.sin(elapsed * 2 + i) * 0.15 + 0.2;
        if (dp[i * 3 + 2] > TRACK_LENGTH / 2) dp[i * 3 + 2] = -TRACK_LENGTH / 2;
      }
      dustGeo.attributes.position.needsUpdate = true;

      // Board update
      lastBoardUpdate += dt;
      if (lastBoardUpdate > 0.5) {
        updateBoard();
        lastBoardUpdate = 0;
      }

      // Countdown update
      lastCountdownUpdate += dt;
      if (lastCountdownUpdate > 0.25) {
        const raceState = raceRef.current;
        raceState.secondsLeft = Math.max(0, raceState.secondsLeft - 0.25);
        const cd = document.getElementById("cdNum");
        if (cd) cd.textContent = `~${Math.max(0, Math.round(raceState.secondsLeft))}s`;
        const wait = document.getElementById("myWait");
        if (wait) wait.textContent = `~${Math.max(0, Math.round(raceState.secondsLeft))}s`;
        lastCountdownUpdate = 0;
      }

      renderer.render(scene, camera);
    };

    animate();

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", onResize);

    // ─── MEMPOOL + BLOCK STREAM (SSE) ──────────────────────────
    const es = new EventSource("/api/eth/stream");
    let lastMineReceiptCheck = 0;
    let raceInitialized = false;

    const addFeed = (icon: string, text: string, cls = "") => {
      const feed = document.getElementById("feed");
      if (!feed) return;
      const item = document.createElement("div");
      item.className = "feed-item";
      item.innerHTML = `<span>${icon}</span><span class="${cls}">${text}</span>`;
      feed.insertBefore(item, feed.firstChild);
      if (feed.children.length > 6) {
        const last = feed.lastChild;
        if (last) feed.removeChild(last);
      }
    };

    const selectTopHorses = (): HorseData[] => {
      const candidates = Array.from(pendingMapRef.current.values())
        .map((v) => v.tx)
        .sort((a, b) => b.effectiveGasGwei - a.effectiveGasGwei);

      const mine = mineTxRef.current;
      const out: HorseData[] = [];

      for (let i = 0; i < NUM_LANES; i++) {
        const c = candidates[i];
        if (!c) break;
        out.push({
          txHash: c.hash,
          gasGwei: c.effectiveGasGwei,
          from: c.from,
          nonce: c.nonce,
          isMine: false,
          color: gasToColorHex(c.effectiveGasGwei),
        });
      }

      if (mine && !raceRef.current.mineConfirmed) {
        const already = out.some((h) => h.txHash.toLowerCase() === mine.hash.toLowerCase());
        if (!already) {
          const lane = Math.max(0, Math.min(NUM_LANES - 1, out.length - 1));
          const gas = mine.effectiveGasGwei ?? 0;
          out[lane] = {
            txHash: mine.hash,
            gasGwei: gas,
            from: mine.from,
            nonce: mine.nonce,
            isMine: true,
            color: 0xc9953a,
          };
        } else {
          const idx = out.findIndex(
            (h) => h.txHash.toLowerCase() === mine.hash.toLowerCase()
          );
          if (idx >= 0) out[idx] = { ...out[idx], isMine: true, color: 0xc9953a };
        }
      }

      // Fill up remaining lanes so the track stays populated.
      while (out.length < NUM_LANES) {
        const laneIndex = out.length;
        const gas = 10 + Math.floor(Math.random() * 40);
        out.push({
          txHash: `fill-${laneIndex}-${Math.random().toString(16).slice(2)}`,
          gasGwei: gas,
          from: "0x0000000000000000000000000000000000000000",
          nonce: laneIndex,
          isMine: false,
          color: gasToColorHex(gas),
        });
      }

      // Ensure we have uniqueish hashes (helps board readability).
      return out.slice(0, NUM_LANES);
    };

    const refreshHorseRace = (blockNumber: number, timestamp: number) => {
      const raceState = raceRef.current;
      raceState.currentBlockNumber = blockNumber;
      raceState.raceTargetBlockNumber = blockNumber + 1;

      const flash = document.getElementById("blockFlash");
      if (flash) {
        flash.classList.add("flash");
        setTimeout(() => flash.classList.remove("flash"), 200);
      }

      showToast(`⛓ Block #${blockNumber.toLocaleString()} mined — race reset`);

      const hBlock = document.getElementById("hBlock");
      if (hBlock) hBlock.textContent = blockNumber.toLocaleString();
      const raceBlock = document.getElementById("raceBlock");
      if (raceBlock) raceBlock.textContent = (blockNumber + 1).toLocaleString();

      // Countdown estimate
      if (raceState.lastBlockTimestamp != null) {
        const delta = Math.max(5, Math.min(25, timestamp - raceState.lastBlockTimestamp));
        raceState.blockTimeSec = delta;
        raceState.secondsLeft = delta;
      } else {
        raceState.blockTimeSec = 13;
        raceState.secondsLeft = 13;
      }
      raceState.lastBlockTimestamp = timestamp;

      // Update my panel with bet offsets (best-effort; the real outcome is known on receipt).
      if (mineTxRef.current) {
        const myGas = document.getElementById("myGas");
        if (myGas) myGas.textContent = `${Math.round(mineTxRef.current.effectiveGasGwei ?? 0)}`;
        const myBlock = document.getElementById("myBlock");
        if (myBlock) {
          if (betRef.current && betRef.current.offset !== 99) {
            myBlock.textContent = `+${betRef.current.offset}`;
          } else if (betRef.current?.offset === 99) {
            myBlock.textContent = `stuck?`;
          } else {
            myBlock.textContent = "+?";
          }
        }
      }

      const top = selectTopHorses();
      setHorsesForRace(top);
      updateBoard();
      // Reset countdown UI immediately for responsiveness.
      const cd = document.getElementById("cdNum");
      if (cd) cd.textContent = `~${Math.max(0, Math.round(raceState.secondsLeft))}s`;
    };

    const checkMineReceipt = async () => {
      const mine = mineTxRef.current;
      if (!mine || raceRef.current.mineConfirmed) return;

      const now = Date.now();
      if (now - lastMineReceiptCheck < 2500) return;
      lastMineReceiptCheck = now;

      const r = await fetch(`/api/eth/tx/receipt?hash=${encodeURIComponent(mine.hash)}`).catch(() => null);
      if (!r) return;
      const json = (await r.json()) as { receipt: unknown };
      const receipt = json.receipt as
        | { blockNumber?: string; status?: string }
        | null;
      if (!receipt || !receipt.blockNumber) return;

      const receiptBlockNumber = Number(BigInt(receipt.blockNumber));
      const status =
        typeof receipt.status === "string"
          ? Number(BigInt(receipt.status))
          : null;

      raceRef.current.mineConfirmed = true;
      raceRef.current.mineConfirmedBlock = receiptBlockNumber;

      // If it confirms, show celebration + cross the finish line (visual).
      showToast(`🏁 Your tx confirmed in block #${receiptBlockNumber.toLocaleString()}${status === 0 ? " (failed)" : ""}!`);
      spawnConfetti();

      // Resolve bet if we have an active bet.
      if (betRef.current && !betRef.current.resolved) {
        const bet = betRef.current;
        let won = false;
        if (bet.offset === 99) {
          won = receiptBlockNumber >= bet.targetBlockNumber; // later than +3
        } else {
          won = receiptBlockNumber === bet.targetBlockNumber;
        }

        bet.resolved = true;
        showToast(won ? "Bet hit! Gold move!" : "Oof. Someone beat you to the block.");
      }
    };

    // Drop detection: expire old pending entries.
    const EXPIRY_MS = 60_000;
    const dropInterval = setInterval(() => {
      const now = Date.now();
      for (const [hash, v] of pendingMapRef.current.entries()) {
        if (now - v.seenAt > EXPIRY_MS) {
          pendingMapRef.current.delete(hash);
          const feedMine = mineTxRef.current && mineTxRef.current.hash.toLowerCase() === hash.toLowerCase();
          if (!feedMine) addFeed("💨", `${formatHashShort(hash)} dropped`, "fd");
        }
      }
    }, 3000);

    es.addEventListener("pending", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as PendingTx;
      const key = `${data.from.toLowerCase()}:${data.nonce}`;

      const prev = pendingBySenderNonceRef.current.get(key);
      if (!prev) {
        pendingBySenderNonceRef.current.set(key, data);
        pendingMapRef.current.set(data.hash, { tx: data, seenAt: Date.now() });
        addFeed("🐎", `${formatHashShort(data.hash)} entered · ${Math.round(data.effectiveGasGwei)}g`, "fe");
      } else if (prev.hash.toLowerCase() !== data.hash.toLowerCase()) {
        // Replacement / bump detection for same sender+nonce.
        if (prev.effectiveGasGwei < data.effectiveGasGwei) {
          pendingBySenderNonceRef.current.set(key, data);
          pendingMapRef.current.set(data.hash, { tx: data, seenAt: Date.now() });
          addFeed("⚡", `${formatHashShort(data.hash)} bumped → ${Math.round(data.effectiveGasGwei)}g`, "fe");
        } else {
          // Still track it, but don't spam a "bump" feed.
          pendingMapRef.current.set(data.hash, { tx: data, seenAt: Date.now() });
        }
      } else {
        pendingMapRef.current.set(data.hash, { tx: data, seenAt: Date.now() });
      }
    });

    es.addEventListener("stats", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as {
        baseFeeGwei: number | null;
        utilizationPct: number | null;
        pendingCount: number;
      };

      const baseFee = document.getElementById("hBaseFee");
      if (baseFee && data.baseFeeGwei != null) baseFee.textContent = Math.round(data.baseFeeGwei).toString();
      const util = document.getElementById("hUtil");
      if (util && data.utilizationPct != null) util.textContent = `${Math.round(data.utilizationPct)}%`;
      const pending = document.getElementById("hPending");
      if (pending) pending.textContent = data.pendingCount.toLocaleString();
    });

    es.addEventListener("block", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as {
        blockNumber: number;
        timestamp: number;
      };
      if (!raceInitialized) {
        raceInitialized = true;
        showToast("Live race started. Watch the track!");
      }

      refreshHorseRace(data.blockNumber, data.timestamp);
      void checkMineReceipt();
    });

    es.onerror = () => {
      // If RPC creds are missing, the server endpoint likely errors. This is a best-effort UI.
      showToast("Connection to mempool stream lost. Retrying…");
    };

    return () => {
      try {
        if (rafId) cancelAnimationFrame(rafId);
      } catch {
        // ignore
      }
      clearInterval(dropInterval);
      es.close();
      window.removeEventListener("resize", onResize);
      clearHorses();
      renderer.dispose();
      if (renderer.domElement && renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }
    };
  }, [horseLaneHues]);

  const connectWallet = async () => {
    if (!window.ethereum) {
      showToastOutside("No wallet found. Install MetaMask or paste a tx hash.");
      return;
    }
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      setWalletAddress(address);
      showToastOutside(`Connected: ${formatHashShort(address)}`);
    } catch {
      showToastOutside("Wallet connection failed.");
    }
  };

  const showToastOutside = (msg: string) => {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2600);
  };

  const enterTxHash = async () => {
    const hash = txHashInput.trim();
    if (!hash || !/^0x([A-Fa-f0-9]{64})$/.test(hash)) {
      showToastOutside("Paste a valid 0x tx hash (66 chars).");
      return;
    }

    showToastOutside("Loading tx…");
    const res = await fetch(`/api/eth/tx/by-hash?hash=${encodeURIComponent(hash)}`).catch(() => null);
    if (!res) {
      showToastOutside("RPC unreachable. Check ETH_RPC_HTTP_URL.");
      return;
    }
    const json = (await res.json()) as { tx: MineTx | null };
    if (!json.tx) {
      showToastOutside("Tx not found yet (or wrong network).");
      return;
    }

    setMineTx(json.tx);
    mineTxRef.current = json.tx;

    // Reset bet resolution state for a fresh ride.
    betRef.current = null;
    setActiveBet(null);

    showToastOutside("You’re in the race. Good luck!");
  };

  const placeBet = (choice: BetChoice) => {
    const raceState = raceRef.current;
    setActiveBet(choice);
    const targetBase = raceState.raceTargetBlockNumber;
    const targetBlockNumber =
      choice === 99 ? targetBase + 4 : targetBase + choice;

    betRef.current = {
      offset: choice,
      targetBlockNumber,
      resolved: false,
    };

    const label = choice === 99 ? "stuck" : choice === 0 ? "this block" : `+${choice}`;
    showToastOutside(`Bet placed: ${label}`);
  };

  const onBetButtonClass = (choice: BetChoice) =>
    choice === activeBet ? "bet-btn active" : "bet-btn";

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        #canvas-container { position: fixed; inset: 0; }

        /* HUD OVERLAY */
        .hud { position: fixed; inset: 0; pointer-events: none; z-index: 10; }

        .top-bar {
          position: absolute;
          top: 0; left: 0; right: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 20px 28px 16px;
          background: linear-gradient(180deg, rgba(10,10,15,0.92) 0%, transparent 100%);
          pointer-events: all;
        }

        .logo {
          font-family: 'Fraunces', serif;
          font-size: 20px;
          font-weight: 900;
          letter-spacing: -0.3px;
          color: #fff;
        }
        .logo span { color: #C9953A; }

        .top-stats {
          display: flex;
          gap: 20px;
          align-items: center;
        }
        .top-stat { text-align: center; }
        .top-stat-val {
          font-size: 16px;
          font-weight: 500;
          color: #fff;
          line-height: 1;
        }
        .top-stat-val.hot { color: #F0C96A; }
        .top-stat-val.green { color: #52B788; }
        .top-stat-lbl {
          font-size: 9px;
          color: rgba(255,255,255,0.4);
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-top: 3px;
        }

        .live-pill {
          display: flex;
          align-items: center;
          gap: 6px;
          background: rgba(82, 183, 136, 0.15);
          border: 1px solid rgba(82,183,136,0.3);
          color: #52B788;
          font-size: 11px;
          padding: 5px 12px;
          border-radius: 20px;
        }
        .live-dot {
          width: 6px; height: 6px;
          border-radius: 50%;
          background: #52B788;
          animation: blink 1.4s infinite;
        }
        @keyframes blink { 0%,100%{opacity:1}50%{opacity:0.2} }

        /* BET BAR — top center */
        .bet-bar {
          position: absolute;
          top: 72px;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          align-items: center;
          gap: 8px;
          background: rgba(10,10,15,0.8);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 40px;
          padding: 6px 8px 6px 14px;
          backdrop-filter: blur(12px);
          pointer-events: all;
          white-space: nowrap;
        }
        .bet-label {
          font-size: 11px;
          color: rgba(255,255,255,0.4);
        }
        .bet-btn {
          padding: 5px 14px;
          border-radius: 20px;
          font-size: 11px;
          font-family: 'DM Mono', monospace;
          cursor: pointer;
          border: 1px solid rgba(255,255,255,0.15);
          background: transparent;
          color: rgba(255,255,255,0.6);
          transition: all 0.15s;
        }
        .bet-btn:hover { border-color: rgba(255,255,255,0.3); color: #fff; }
        .bet-btn.active { background: #C9953A; border-color: #C9953A; color: #fff; font-weight: 500; }

        /* COUNTDOWN ARC — center top */
        .countdown-wrap {
          position: absolute;
          top: 118px;
          left: 50%;
          transform: translateX(-50%);
          text-align: center;
          pointer-events: none;
        }
        .countdown-num {
          font-family: 'Fraunces', serif;
          font-size: 13px;
          font-weight: 700;
          color: rgba(255,255,255,0.5);
        }
        .countdown-lbl {
          font-size: 9px;
          color: rgba(255,255,255,0.25);
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }

        /* MY TX PANEL — bottom left */
        .my-tx {
          position: absolute;
          bottom: 24px;
          left: 24px;
          background: rgba(10,10,15,0.85);
          border: 1px solid rgba(201,149,58,0.4);
          border-radius: 16px;
          padding: 16px 20px;
          min-width: 300px;
          backdrop-filter: blur(12px);
          pointer-events: all;
        }
        .my-tx-label {
          font-size: 10px;
          color: rgba(255,255,255,0.4);
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .my-star { color: #C9953A; }
        .my-tx-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin-top: 12px;
          margin-bottom: 10px;
        }
        .my-tx-stat-val {
          font-family: 'Fraunces', serif;
          font-size: 22px;
          font-weight: 700;
          line-height: 1;
        }
        .gold { color: #C9953A; }
        .green { color: #52B788; }
        .white { color: #fff; }
        .my-tx-stat-lbl {
          font-size: 10px;
          color: rgba(255,255,255,0.4);
          margin-top: 3px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }

        .mine-form { display: flex; flex-direction: column; gap: 10px; }
        .connect-btn {
          padding: 8px 12px;
          border-radius: 12px;
          font-size: 12px;
          border: 1px solid rgba(255,255,255,0.15);
          background: rgba(201,149,58,0.08);
          color: #fff;
          cursor: pointer;
          font-family: 'DM Mono', monospace;
          transition: all 0.15s;
        }
        .connect-btn:hover { border-color: rgba(255,255,255,0.3); }

        .wallet-chip {
          padding: 8px 12px;
          border-radius: 12px;
          font-size: 12px;
          color: #C9953A;
          border: 1px solid rgba(201,149,58,0.35);
          background: rgba(201,149,58,0.08);
        }

        .tx-input-row { display: flex; gap: 8px; }
        .tx-input {
          flex: 1;
          padding: 10px 12px;
          border-radius: 12px;
          font-size: 12px;
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.06);
          color: #fff;
          outline: none;
          font-family: 'DM Mono', monospace;
        }
        .tx-input::placeholder { color: rgba(255,255,255,0.35); }
        .tx-enter-btn {
          padding: 10px 14px;
          border-radius: 12px;
          font-size: 12px;
          border: 1px solid rgba(201,149,58,0.55);
          background: rgba(201,149,58,0.12);
          color: #C9953A;
          cursor: pointer;
          transition: all 0.15s;
          font-family: 'DM Mono', monospace;
          white-space: nowrap;
        }
        .tx-enter-btn:hover { background: rgba(201,149,58,0.2); }

        .tx-hash-row {
          margin-top: 2px;
          padding-top: 10px;
          border-top: 1px solid rgba(255,255,255,0.08);
          font-size: 10px;
          color: rgba(255,255,255,0.35);
          word-break: break-all;
        }

        /* RACE BOARD — bottom right */
        .race-board {
          position: absolute;
          bottom: 24px;
          right: 24px;
          background: rgba(10,10,15,0.85);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 16px;
          overflow: hidden;
          backdrop-filter: blur(12px);
          min-width: 320px;
          pointer-events: all;
        }
        .race-board-head {
          padding: 10px 16px;
          border-bottom: 1px solid rgba(255,255,255,0.07);
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 11px;
          color: rgba(255,255,255,0.5);
        }
        .race-board-head b { color: #fff; }

        .board-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 7px 16px;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          font-size: 11px;
          transition: background 0.2s;
        }
        .board-row:last-child { border-bottom: none; }
        .board-row.mine { background: rgba(201,149,58,0.1); }
        .board-pos { color: rgba(255,255,255,0.3); width: 16px; }
        .board-name { flex: 1; color: rgba(255,255,255,0.7); }
        .board-name.mine { color: #C9953A; font-weight: 500; }
        .board-gas { color: #fff; font-weight: 500; }
        .board-block { font-size: 10px; padding: 2px 8px; border-radius: 10px; }
        .block-now { background: rgba(82,183,136,0.2); color: #52B788; }
        .block-1   { background: rgba(201,149,58,0.15); color: #C9953A; }
        .block-2   { background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.4); }
        .block-late { background: rgba(193,68,14,0.15); color: #E86A4A; }

        /* FEED — left side scrolling */
        .feed {
          position: absolute;
          top: 50%;
          left: 20px;
          transform: translateY(-50%);
          display: flex;
          flex-direction: column;
          gap: 4px;
          max-height: 240px;
          overflow: hidden;
          pointer-events: none;
        }
        .feed-item {
          font-size: 10px;
          color: rgba(255,255,255,0.35);
          display: flex;
          gap: 6px;
          animation: feedSlide 0.3s ease;
          white-space: nowrap;
        }
        @keyframes feedSlide { from { opacity:0; transform:translateX(-10px); } to { opacity:1; transform:translateX(0); } }
        .feed-item .fe { color: rgba(255,255,255,0.6); }
        .feed-item .fc { color: #52B788; }
        .feed-item .fd { color: #E86A4A; }

        /* BLOCK FLASH */
        .block-flash {
          position: fixed;
          inset: 0;
          background: rgba(201,149,58,0.15);
          pointer-events: none;
          z-index: 20;
          opacity: 0;
          transition: opacity 0.1s;
        }
        .block-flash.flash { opacity: 1; }

        /* TOAST */
        .toast {
          position: fixed;
          bottom: 100px;
          left: 50%;
          transform: translateX(-50%) translateY(40px);
          background: rgba(10,10,15,0.95);
          border: 1px solid rgba(201,149,58,0.5);
          color: #C9953A;
          padding: 10px 22px;
          border-radius: 40px;
          font-size: 13px;
          font-family: 'DM Mono', monospace;
          transition: transform 0.35s cubic-bezier(0.22,1,0.36,1), opacity 0.35s;
          z-index: 999;
          opacity: 0;
          white-space: nowrap;
          backdrop-filter: blur(12px);
          pointer-events: none;
        }
        .toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }

        /* CONFETTI */
        .conf-layer { position: fixed; inset: 0; pointer-events: none; z-index: 998; }
        .conf-p {
          position: absolute;
          width: 7px; height: 7px;
          border-radius: 2px;
          animation: confFall 1.1s ease-in forwards;
        }
        @keyframes confFall {
          0%   { transform: translateY(-10px) rotate(0deg); opacity: 1; }
          100% { transform: translateY(100vh) rotate(540deg); opacity: 0; }
        }
      `}</style>

      <div id="canvas-container" ref={containerRef} />

      <div className="hud">
        <div className="top-bar">
          <div className="logo">🐎 <span>gwei</span>.run</div>

          <div className="top-stats">
            <div className="top-stat">
              <div className="top-stat-val hot" id="hBaseFee">
                —
              </div>
              <div className="top-stat-lbl">base fee</div>
            </div>
            <div className="top-stat">
              <div className="top-stat-val hot" id="hUtil">
                —
              </div>
              <div className="top-stat-lbl">utilization</div>
            </div>
            <div className="top-stat">
              <div className="top-stat-val" id="hPending">
                —
              </div>
              <div className="top-stat-lbl">pending txs</div>
            </div>
            <div className="top-stat">
              <div className="top-stat-val" id="hBlock">
                —
              </div>
              <div className="top-stat-lbl">current block</div>
            </div>
          </div>

          <div className="live-pill">
            <div className="live-dot"></div>
            live mainnet
          </div>
        </div>

        <div className="bet-bar">
          <span className="bet-label">bet your block:</span>
          <button className={onBetButtonClass(0)} onClick={() => placeBet(0)}>
            this
          </button>
          <button className={onBetButtonClass(1)} onClick={() => placeBet(1)}>
            +1
          </button>
          <button className={onBetButtonClass(2)} onClick={() => placeBet(2)}>
            +2
          </button>
          <button className={onBetButtonClass(3)} onClick={() => placeBet(3)}>
            +3
          </button>
          <button className={onBetButtonClass(99)} onClick={() => placeBet(99)}>
            stuck
          </button>
        </div>

        <div className="countdown-wrap">
          <div className="countdown-num" id="cdNum">
            ~12s
          </div>
          <div className="countdown-lbl">to next block</div>
        </div>

        <div className="feed" id="feed"></div>

        <div className="my-tx">
          <div className="my-tx-label">
            <span>Your transaction</span>
            <span className="my-star">★ YOUR TX</span>
          </div>

          <div className="mine-form">
            {!walletAddress ? (
              <button className="connect-btn" onClick={connectWallet}>
                Connect wallet
              </button>
            ) : (
              <div className="wallet-chip">
                Wallet: {formatHashShort(walletAddress)}
              </div>
            )}

            <div className="tx-input-row">
              <input
                className="tx-input"
                value={txHashInput}
                onChange={(e) => setTxHashInput(e.target.value)}
                placeholder="Paste tx hash (0x...)"
              />
              <button className="tx-enter-btn" onClick={enterTxHash}>
                Watch
              </button>
            </div>
          </div>

          <div className="my-tx-grid">
            <div>
              <div className="my-tx-stat-val gold" id="myGas">
                {mineTx ? Math.round(mineTx.effectiveGasGwei ?? 0) : 0}
              </div>
              <div className="my-tx-stat-lbl">gwei</div>
            </div>
            <div>
              <div className="my-tx-stat-val white" id="myRank">
                #—
              </div>
              <div className="my-tx-stat-lbl">rank</div>
            </div>
            <div>
              <div className="my-tx-stat-val green" id="myBlock">
                +?
              </div>
              <div className="my-tx-stat-lbl">est block</div>
            </div>
            <div>
              <div className="my-tx-stat-val white" id="myWait">
                ~12s
              </div>
              <div className="my-tx-stat-lbl">eta</div>
            </div>
          </div>

          <div className="tx-hash-row" id="myTxHashRow">
            {mineTx ? `${formatHashShort(mineTx.hash)} · ...` : "Paste a tx hash to enter the race."}
          </div>
        </div>

        <div className="race-board">
          <div className="race-board-head">
            <span>
              Race to block <b id="raceBlock">—</b>
            </span>
            <span id="raceCount">— horses</span>
          </div>
          <div id="boardRows"></div>
        </div>
      </div>

      <div className="block-flash" id="blockFlash"></div>
      <div className="toast" id="toast"></div>
      <div className="conf-layer" id="confLayer"></div>
    </>
  );
}

