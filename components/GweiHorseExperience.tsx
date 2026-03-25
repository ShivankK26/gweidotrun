"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type PendingTx = {
  hash: string;
  from: string;
  nonce: number;
  effectiveGasGwei: number;
};

type PoolTx = {
  hash: string;
  from: string;
  nonce: number;
  gas: number;
  value: string;
};

type MineTx = {
  hash: string;
  from: string;
  nonce: number;
  valueWei: string;
  effectiveGasGwei: number | null;
};

type BetChoice = 0 | 1 | 2 | 3 | 99;

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
  const AppKitWalletPill = dynamic(() => import("@/components/AppKitWalletPill"), {
    ssr: false,
  });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const watchedAddressRef = useRef<string | null>(null);
  const confirmPollerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trackMineFromAddressRef = useRef<boolean>(false);

  const mineTxRef = useRef<MineTx | null>(null);

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
  const [mineTx, setMineTx] = useState<MineTx | null>(null);

  const horseLaneHues = useMemo(() => {
    const arr: number[] = [];
    for (let i = 0; i < NUM_LANES; i++) arr.push(i / NUM_LANES);
    return arr;
  }, []);

  useEffect(() => {
    mineTxRef.current = mineTx;
  }, [mineTx]);
  useEffect(() => {
    const onAccount = (evt: Event) => {
      const ce = evt as CustomEvent<{ isConnected?: boolean; address?: string | null }>;
      const next =
        ce.detail?.isConnected && ce.detail.address ? ce.detail.address : null;
      setWalletAddress(next);
    };
    window.addEventListener("appkit-account", onAccount as EventListener);
    return () => {
      window.removeEventListener("appkit-account", onAccount as EventListener);
    };
  }, []);
  useEffect(() => {
    if (!walletAddress) return;
    watchedAddressRef.current = walletAddress;
    trackMineFromAddressRef.current = true;
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

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.5, -8);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 1.0;
    controls.panSpeed = 0.8;
    controls.minDistance = 6;
    controls.maxDistance = 80;
    controls.minPolarAngle = 0.1;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    controls.update();

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

      controls.update();

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

    // ─── MEMPOOL + BLOCK STREAM (SERVER-SIDE PROXY) ────────────
    const es = new EventSource("/api/eth/stream");
    const txPool = new Map<string, PoolTx>();
    let raceInitialized = false;
    let raceRebuildTimer: ReturnType<typeof setTimeout> | null = null;

    function addFeedPill(
      type: "enter" | "confirm" | "drop" | "bump" | "block",
      icon: string,
      hash: string | null,
      label: string
    ) {
      const container = document.getElementById("feed-pills");
      if (!container) return;

      // Keep max 4 pills visible.
      while (container.children.length >= 4) {
        container.removeChild(container.firstChild as ChildNode);
      }

      const pill = document.createElement("div");
      pill.className = `feed-pill type-${type}`;
      pill.innerHTML = `
        <span style="font-size:13px">${icon}</span>
        ${hash ? `<span class="pill-hash">${hash}</span>` : ""}
        <span>${label}</span>
      `;

      container.appendChild(pill);
      window.setTimeout(() => pill?.remove(), 4000);
    }

    const selectTopHorses = (): HorseData[] => {
      const candidates = Array.from(txPool.values()).sort((a, b) => b.gas - a.gas);
      const mine = mineTxRef.current;
      const watched = watchedAddressRef.current?.toLowerCase();
      const out: HorseData[] = [];

      for (let i = 0; i < NUM_LANES; i++) {
        const c = candidates[i];
        if (!c) break;
        out.push({
          txHash: c.hash,
          gasGwei: c.gas,
          from: c.from,
          nonce: c.nonce,
          isMine: watched != null && c.from.toLowerCase() === watched,
          color: gasToColorHex(c.gas),
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

    const rebuildRace = () => {
      const top = selectTopHorses();
      setHorsesForRace(top);
      updateBoard();

      const mineHorse = top.find((h) => h.isMine);
      if (mineHorse) {
        const myGas = document.getElementById("myGas");
        if (myGas) myGas.textContent = `${Math.round(mineHorse.gasGwei)}`;
        const row = document.getElementById("myTxHashRow");
        if (row) row.textContent = `${formatHashShort(mineHorse.txHash)} · watching`;
      }
    };

    const scheduleRebuildRace = () => {
      if (raceRebuildTimer) return;
      raceRebuildTimer = setTimeout(() => {
        raceRebuildTimer = null;
        rebuildRace();
      }, 180);
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
      addFeedPill("block", "⛓", null, `block #${blockNumber.toLocaleString()} mined`);

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

      txPool.clear();
      pendingMapRef.current.clear();
      pendingBySenderNonceRef.current.clear();
      setHorsesForRace(selectTopHorses());
      updateBoard();
      // Reset countdown UI immediately for responsiveness.
      const cd = document.getElementById("cdNum");
      if (cd) cd.textContent = `~${Math.max(0, Math.round(raceState.secondsLeft))}s`;
    };

    const checkMineReceipt = async () => {
      const mine = mineTxRef.current;
      if (!mine || raceRef.current.mineConfirmed) return;
      const r = await fetch(`/api/eth/tx/receipt?hash=${encodeURIComponent(mine.hash)}`).catch(
        () => null
      );
      if (!r) return;
      const json = (await r.json()) as { receipt?: unknown };
      const receipt = (json.receipt ?? null) as
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
      addFeedPill(
        "confirm",
        "🏁",
        formatHashShort(mine.hash),
        `confirmed in block #${receiptBlockNumber.toLocaleString()}${status === 0 ? " (failed)" : ""}`
      );
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

      if (confirmPollerRef.current) {
        clearInterval(confirmPollerRef.current);
        confirmPollerRef.current = null;
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
          if (!feedMine)
            addFeedPill("drop", "💨", formatHashShort(hash), "dropped — gas too low");
        }
      }
    }, 3000);

    const ingestPendingTx = (tx: {
      hash?: string;
      from?: string;
      nonce?: string;
      gasPrice?: string;
      maxFeePerGas?: string;
      value?: string;
    }) => {
      if (!tx.hash || !tx.from || !tx.nonce) return;
      const gasRaw = tx.gasPrice ?? tx.maxFeePerGas;
      if (!gasRaw) return;

      const gas = Number(BigInt(gasRaw) / BigInt(1_000_000_000));
      if (!Number.isFinite(gas)) return;
      const nonceNum = Number(BigInt(tx.nonce));

      const poolTx: PoolTx = {
        hash: tx.hash,
        from: tx.from,
        nonce: nonceNum,
        gas,
        value: tx.value ?? "0x0",
      };

      const key = `${poolTx.from.toLowerCase()}:${poolTx.nonce}`;
      const prev = pendingBySenderNonceRef.current.get(key);
      const pendingLike: PendingTx = {
        hash: poolTx.hash,
        from: poolTx.from,
        nonce: poolTx.nonce,
        effectiveGasGwei: poolTx.gas,
      };

      txPool.set(poolTx.hash, poolTx);
      pendingMapRef.current.set(poolTx.hash, { tx: pendingLike, seenAt: Date.now() });

      if (!prev) {
        pendingBySenderNonceRef.current.set(key, pendingLike);
        addFeedPill(
          "enter",
          "🐎",
          formatHashShort(poolTx.hash),
          `entered · ${Math.round(poolTx.gas)}g`
        );
      } else if (prev.hash.toLowerCase() !== poolTx.hash.toLowerCase()) {
        if (prev.effectiveGasGwei < poolTx.gas) {
          pendingBySenderNonceRef.current.set(key, pendingLike);
          addFeedPill(
            "bump",
            "⚡",
            formatHashShort(poolTx.hash),
            `bumped → ${Math.round(poolTx.gas)}g`
          );
        }
      }

      if (trackMineFromAddressRef.current) {
        const watched = watchedAddressRef.current?.toLowerCase();
        if (watched && poolTx.from.toLowerCase() === watched) {
          const mineTx: MineTx = {
            hash: poolTx.hash,
            from: poolTx.from,
            nonce: poolTx.nonce,
            valueWei: poolTx.value,
            effectiveGasGwei: poolTx.gas,
          };
          setMineTx(mineTx);
          mineTxRef.current = mineTx;
          const row = document.getElementById("myTxHashRow");
          if (row) row.textContent = `${formatHashShort(poolTx.hash)} · tracked from wallet`;
          if (!confirmPollerRef.current) {
            confirmPollerRef.current = setInterval(() => {
              void checkMineReceipt();
            }, 3000);
          }
        }
      }

      const pendingEl = document.getElementById("hPending");
      if (pendingEl) pendingEl.textContent = txPool.size.toLocaleString();
      scheduleRebuildRace();
    };

    es.addEventListener("pending", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as {
        hash?: string;
        from?: string;
        nonce?: number;
        effectiveGasGwei?: number;
      };
      if (!data.hash || !data.from || data.nonce == null || data.effectiveGasGwei == null) return;
      ingestPendingTx({
        hash: data.hash,
        from: data.from,
        nonce: `0x${data.nonce.toString(16)}`,
        gasPrice: `0x${Math.max(0, Math.round(data.effectiveGasGwei * 1e9)).toString(16)}`,
        value: "0x0",
      });
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
      showToast("Connection lost. Reconnecting stream...");
    };

    return () => {
      try {
        if (rafId) cancelAnimationFrame(rafId);
      } catch {
        // ignore
      }
      clearInterval(dropInterval);
      if (raceRebuildTimer) clearTimeout(raceRebuildTimer);
      if (confirmPollerRef.current) {
        clearInterval(confirmPollerRef.current);
        confirmPollerRef.current = null;
      }
      es.close();
      window.removeEventListener("resize", onResize);
      controls.dispose();
      clearHorses();
      renderer.dispose();
      if (renderer.domElement && renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }
    };
  }, [horseLaneHues]);

  const isMineTxVisible = Boolean(mineTx);

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        #canvas-container { position: fixed; inset: 0; }
        .hud { position: fixed; inset: 0; pointer-events: none; z-index: 10; }
        :root {
          --gold: #c9953a;
          --gold-light: #f0c96a;
          --green: #52b788;
          --red: #e86a4a;
          --glass: rgba(10, 10, 18, 0.72);
          --glass-border: rgba(255, 255, 255, 0.09);
          --muted: rgba(255, 255, 255, 0.38);
        }

        .header {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 18px 28px;
          background: linear-gradient(180deg, rgba(10, 10, 18, 0.95) 0%, transparent 100%);
          pointer-events: all;
        }

        .logo {
          font-family: "Fraunces", serif;
          font-size: 20px;
          font-weight: 900;
          letter-spacing: -0.3px;
          display: flex;
          gap: 6px;
          align-items: center;
        }
        .logo-img {
          display: block;
        }
        .logo em {
          color: var(--gold);
          font-style: normal;
        }
        .header-right {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .pill {
          display: flex;
          align-items: center;
          gap: 6px;
          background: var(--glass);
          border: 1px solid var(--glass-border);
          border-radius: 40px;
          padding: 6px 14px;
          font-size: 11px;
          backdrop-filter: blur(16px);
          color: #fff;
          cursor: pointer;
          transition: border-color 0.2s, background 0.2s;
          white-space: nowrap;
        }
        .pill:hover {
          border-color: rgba(255, 255, 255, 0.2);
          background: rgba(10, 10, 18, 0.88);
        }
        .pill.active {
          border-color: rgba(201, 149, 58, 0.5);
          background: rgba(201, 149, 58, 0.12);
          color: var(--gold-light);
        }
        .live-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--green);
          animation: blink 1.4s infinite;
        }
        @keyframes blink {
          0%,
          100% {
            opacity: 1;
          }
          50% {
            opacity: 0.25;
          }
        }

        .block-bar {
          position: absolute;
          top: 72px;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          background: var(--glass);
          border: 1px solid var(--glass-border);
          border-radius: 40px;
          overflow: hidden;
          backdrop-filter: blur(16px);
          pointer-events: all;
        }
        .block-stat {
          padding: 8px 20px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          border-right: 1px solid var(--glass-border);
        }
        .block-stat:last-child {
          border-right: none;
        }
        .block-stat-val {
          font-size: 14px;
          font-weight: 500;
          color: #fff;
          line-height: 1;
        }
        .block-stat-val.gold {
          color: var(--gold-light);
        }
        .block-stat-val.hot {
          color: var(--red);
        }
        .block-stat-lbl {
          font-size: 9px;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        .my-tx {
          position: absolute;
          bottom: 28px;
          left: 28px;
          background: var(--glass);
          border: 1px solid rgba(201, 149, 58, 0.3);
          border-radius: 18px;
          padding: 16px 20px;
          min-width: 220px;
          backdrop-filter: blur(16px);
          pointer-events: all;
          display: none;
        }
        .my-tx.visible {
          display: block;
        }
        .my-tx-label {
          font-size: 10px;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 10px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .my-star {
          color: var(--gold-light);
        }
        .my-tx-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          margin-bottom: 12px;
        }
        .my-tx-stat-val {
          font-family: "Fraunces", serif;
          font-size: 24px;
          font-weight: 700;
          line-height: 1;
        }
        .gold {
          color: var(--gold);
        }
        .green {
          color: var(--green);
        }
        .white {
          color: #fff;
        }
        .my-tx-stat-lbl {
          font-size: 9px;
          color: var(--muted);
          margin-top: 3px;
          text-transform: uppercase;
          letter-spacing: 0.07em;
        }
        .tx-hash-row {
          border-top: 1px solid var(--glass-border);
          padding-top: 10px;
          padding-top: 10px;
          font-size: 10px;
          color: var(--muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .race-board {
          position: absolute;
          top: 50%;
          right: 24px;
          transform: translateY(-50%);
          background: var(--glass);
          border: 1px solid var(--glass-border);
          border-radius: 18px;
          overflow: hidden;
          backdrop-filter: blur(16px);
          min-width: 240px;
          pointer-events: all;
        }
        .race-board-head {
          padding: 11px 16px;
          border-bottom: 1px solid var(--glass-border);
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 10px;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.09em;
        }
        .race-board-head b {
          color: #fff;
        }

        .board-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 16px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
          font-size: 11px;
          transition: background 0.2s;
        }
        .board-row:last-child { border-bottom: none; }
        .board-row.mine {
          background: rgba(201, 149, 58, 0.1);
        }
        .board-pos {
          color: var(--muted);
          width: 16px;
        }
        .board-name {
          flex: 1;
          color: rgba(255, 255, 255, 0.65);
        }
        .board-name.mine {
          color: var(--gold-light);
          font-weight: 500;
        }
        .board-gas {
          color: #fff;
          font-weight: 500;
        }
        .board-block {
          font-size: 10px;
          padding: 2px 7px;
          border-radius: 10px;
        }
        .block-now {
          background: rgba(82, 183, 136, 0.18);
          color: var(--green);
        }
        .block-1 {
          background: rgba(201, 149, 58, 0.15);
          color: var(--gold);
        }
        .block-2 {
          background: rgba(255, 255, 255, 0.07);
          color: var(--muted);
        }
        .block-late {
          background: rgba(232, 106, 74, 0.15);
          color: var(--red);
        }

        .feed {
          position: absolute;
          bottom: 28px;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          flex-direction: column-reverse;
          gap: 4px;
          max-width: 340px;
          overflow: hidden;
          pointer-events: none;
        }
        .feed-item {
          font-size: 10px;
          color: var(--muted);
          background: var(--glass);
          border: 1px solid var(--glass-border);
          border-radius: 20px;
          padding: 5px 14px;
          backdrop-filter: blur(8px);
          animation: feedSlide 0.3s ease;
          white-space: nowrap;
          text-align: center;
          align-self: center;
        }
        @keyframes feedSlide {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .feed-item .fe {
          color: var(--gold-light);
        }
        .feed-item .fc {
          color: var(--green);
        }
        .feed-item .fd {
          color: var(--red);
        }

        #feed-pills {
          position: fixed;
          bottom: 28px;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          z-index: 50;
          pointer-events: none;
        }

        .feed-pill {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 16px;
          background: rgba(10, 10, 18, 0.82);
          border: 1px solid rgba(255, 255, 255, 0.09);
          border-radius: 40px;
          font-size: 12px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
            "Liberation Mono", "Courier New", monospace;
          color: rgba(255, 255, 255, 0.5);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          white-space: nowrap;
          animation: pillIn 0.35s cubic-bezier(0.22, 1, 0.36, 1) forwards,
            pillOut 0.3s ease 3.5s forwards;
          pointer-events: none;
        }

        .feed-pill .pill-hash {
          color: rgba(255, 255, 255, 0.65);
          font-weight: 500;
        }

        .feed-pill.type-enter {
          border-color: rgba(201, 149, 58, 0.25);
        }
        .feed-pill.type-enter .pill-hash {
          color: #f0c96a;
        }

        .feed-pill.type-confirm {
          border-color: rgba(82, 183, 136, 0.35);
        }
        .feed-pill.type-confirm .pill-hash {
          color: #52b788;
        }

        .feed-pill.type-drop {
          border-color: rgba(232, 106, 74, 0.2);
        }
        .feed-pill.type-drop .pill-hash {
          color: #e86a4a;
        }

        .feed-pill.type-bump {
          border-color: rgba(255, 255, 255, 0.12);
        }

        .feed-pill.type-block {
          border-color: rgba(82, 183, 136, 0.4);
          background: rgba(10, 30, 20, 0.88);
        }
        .feed-pill.type-block .pill-hash {
          color: #52b788;
          font-weight: 500;
        }

        @keyframes pillIn {
          from {
            opacity: 0;
            transform: translateY(10px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        @keyframes pillOut {
          from {
            opacity: 1;
            transform: scale(1);
          }
          to {
            opacity: 0;
            transform: scale(0.95);
          }
        }

        .controls-hint {
          position: absolute;
          bottom: 28px;
          right: 24px;
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 6px;
          max-width: 280px;
          z-index: 20;
        }
        .ctrl-tag {
          font-size: 10px;
          color: var(--muted);
          background: var(--glass);
          border: 1px solid var(--glass-border);
          border-radius: 8px;
          padding: 4px 9px;
          backdrop-filter: blur(8px);
        }

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
        .block-flash.flash {
          opacity: 1;
        }

        .toast {
          position: fixed;
          top: 120px;
          left: 50%;
          transform: translateX(-50%) translateY(-10px);
          background: rgba(10, 10, 18, 0.96);
          border: 1px solid rgba(201, 149, 58, 0.4);
          color: var(--gold-light);
          padding: 9px 22px;
          border-radius: 40px;
          font-size: 12px;
          transition: all 0.3s cubic-bezier(0.22, 1, 0.36, 1);
          z-index: 999;
          opacity: 0;
          white-space: nowrap;
          backdrop-filter: blur(12px);
          pointer-events: none;
        }
        .toast.show {
          transform: translateX(-50%) translateY(0);
          opacity: 1;
        }

        .conf-layer {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 998;
        }
        .conf-p {
          position: absolute;
          width: 7px;
          height: 7px;
          border-radius: 2px;
          animation: confFall 1.1s ease-in forwards;
        }
        @keyframes confFall {
          0% {
            transform: translateY(-10px) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(100vh) rotate(540deg);
            opacity: 0;
          }
        }
      `}</style>

      <div id="canvas-container" ref={containerRef} />

      <div className="hud">
        <div className="header">
          <div className="logo">
            <Image
              src="/gwei-run-logo.svg"
              alt="gwei.run"
              width={200}
              height={34}
              className="logo-img"
              unoptimized
              priority
            />
          </div>
          <div className="header-right">
            <div className="pill">
              <div className="live-dot"></div>
              <span>
                live • block <span id="hBlock">—</span>
              </span>
            </div>
            <AppKitWalletPill connectedAddress={walletAddress} />
          </div>
        </div>

        <div className="block-bar">
          <div className="block-stat">
            <div className="block-stat-val gold" id="hBaseFee">
              —
            </div>
            <div className="block-stat-lbl">base fee</div>
          </div>
          <div className="block-stat">
            <div className="block-stat-val hot" id="hUtil">
              —
            </div>
            <div className="block-stat-lbl">utilization</div>
          </div>
          <div className="block-stat">
            <div className="block-stat-val" id="hPending">
              —
            </div>
            <div className="block-stat-lbl">pending</div>
          </div>
          <div className="block-stat">
            <div className="block-stat-val" id="cdNum">
              ~12s
            </div>
            <div className="block-stat-lbl">next block</div>
          </div>
        </div>

        <div className="feed" id="feed"></div>

        <div id="feed-pills" />

        <div className={`my-tx ${isMineTxVisible ? "visible" : ""}`}>
          <div className="my-tx-label">
            <span>Your transaction</span>
            <span className="my-star">★ tracked</span>
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
            {mineTx ? `${formatHashShort(mineTx.hash)} · from connected wallet` : "Waiting for your pending tx..."}
          </div>
        </div>

        <div className="race-board">
          <div className="race-board-head">
            <span>race</span>
            <span>
              block #<b id="raceBlock">—</b>
            </span>
          </div>
          <div id="boardRows"></div>
        </div>

        <div className="controls-hint">
          <span className="ctrl-tag">scroll — zoom</span>
          <span className="ctrl-tag">drag — orbit</span>
          <span className="ctrl-tag">right drag — pan</span>
        </div>
      </div>

      <div className="block-flash" id="blockFlash"></div>
      <div className="toast" id="toast"></div>
      <div className="conf-layer" id="confLayer"></div>
    </>
  );
}

