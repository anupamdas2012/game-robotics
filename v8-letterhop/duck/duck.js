// Microduck live viewer: Three.js (WebGL) renders geometry built from the MuJoCo model's own
// mesh buffers; the physics runs in sim.worker.js and streams geom transforms here each frame.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DUCK_YELLOW = 0xf4c33a;

export function mountDuck(container, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  // MuJoCo is Z-up.
  const camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 0.01, 60);
  camera.up.set(0, 0, 1);
  camera.position.set(0.42, -0.5, 0.28);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0.11);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.minDistance = 0.18;
  controls.maxDistance = 2.5;
  controls.maxPolarAngle = Math.PI * 0.52;   // don't go under the floor

  // lights
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x2a2f38, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(0.5, -0.7, 1.3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.1; key.shadow.camera.far = 4;
  key.shadow.camera.left = -0.6; key.shadow.camera.right = 0.6;
  key.shadow.camera.top = 0.6; key.shadow.camera.bottom = -0.6;
  key.shadow.bias = -0.0004;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.5);
  rim.position.set(-0.6, 0.5, 0.6);
  scene.add(rim);

  // ground (XY plane at z=0 faces +Z — perfect for Z-up)
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 14),
    new THREE.MeshStandardMaterial({ color: 0x1b2730, roughness: 0.98, metalness: 0 })
  );
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(4, 40, 0x335066, 0x24323d);
  grid.rotation.x = Math.PI / 2;   // GridHelper is XZ by default -> lay it in XY
  grid.position.z = 0.001;
  scene.add(grid);

  const duck = new THREE.Group();
  scene.add(duck);
  let meshes = [];   // aligned with worker's frame order
  const base = [0, 0, 0.11];                       // duck base world pos (from worker)
  const smoothTarget = new THREE.Vector3(0, 0, 0.11);
  let follow = opts.follow !== false;

  const worker = new Worker(new URL('./sim.worker.js', import.meta.url), { type: 'module' });
  let ready = false;

  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'ready') {
      for (const g of m.geoms) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(g.verts, 3));
        geo.setIndex(new THREE.BufferAttribute(g.faces, 1));
        geo.computeVertexNormals();
        const c = g.rgba;
        const useDefault = (c[0] <= 0.02 && c[1] <= 0.02 && c[2] <= 0.02) || c[3] === 0;
        const color = useDefault ? DUCK_YELLOW : new THREE.Color(c[0], c[1], c[2]).getHex();
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.12 }));
        mesh.castShadow = true;
        mesh.matrixAutoUpdate = false;
        duck.add(mesh);
        meshes.push(mesh);
      }
      ready = true;
      if (opts.onReady) opts.onReady();
    } else if (m.type === 'frame') {
      const P = m.pos, Mt = m.mat;
      if (m.base) { base[0] = m.base[0]; base[1] = m.base[1]; base[2] = m.base[2]; }
      for (let i = 0; i < meshes.length; i++) {
        const o = i * 9, p = i * 3, mesh = meshes[i];
        mesh.matrix.set(
          Mt[o], Mt[o + 1], Mt[o + 2], P[p],
          Mt[o + 3], Mt[o + 4], Mt[o + 5], P[p + 1],
          Mt[o + 6], Mt[o + 7], Mt[o + 8], P[p + 2],
          0, 0, 0, 1
        );
      }
    } else if (m.type === 'error') {
      console.error('[duck sim]', m.msg);
      if (opts.onError) opts.onError(m.msg);
    }
  };
  worker.postMessage({ cmd: 'init' });

  let raf = 0;
  function animate() {
    raf = requestAnimationFrame(animate);
    if (follow) {                                   // move the orbit target with the duck; OrbitControls
      smoothTarget.lerp(_tmp.set(base[0], base[1], 0.11), 0.08);   // keeps the camera at its offset
      controls.target.copy(smoothTarget);
    }
    controls.update();
    renderer.render(scene, camera);
  }
  const _tmp = new THREE.Vector3(), _delta = new THREE.Vector3();
  animate();

  // ---- drive controls: keyboard + on-screen buttons -> twist command ----
  const pressed = { f: 0, b: 0, l: 0, r: 0 };
  function send() {
    const vx = (pressed.f ? 0.5 : 0) - (pressed.b ? 0.32 : 0);
    const wz = (pressed.l ? 1.7 : 0) - (pressed.r ? 1.7 : 0);
    worker.postMessage({ cmd: 'command', vx, vy: 0, wz });
  }
  const keymap = { ArrowUp: 'f', KeyW: 'f', ArrowDown: 'b', KeyS: 'b', ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r' };
  function onKey(down) {
    return (e) => { const k = keymap[e.code]; if (k) { pressed[k] = down ? 1 : 0; send(); e.preventDefault(); } };
  }
  const kd = onKey(true), ku = onKey(false);
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);

  let pad = null;
  if (opts.buttons !== false) {
    pad = document.createElement('div');
    pad.className = 'duck-pad';
    pad.innerHTML =
      '<button data-k="f" aria-label="forward">▲</button>' +
      '<div class="row"><button data-k="l" aria-label="left">◀</button>' +
      '<button data-k="b" aria-label="back">▼</button>' +
      '<button data-k="r" aria-label="right">▶</button></div>';
    if (!document.getElementById('duck-pad-css')) {
      const s = document.createElement('style'); s.id = 'duck-pad-css';
      s.textContent =
        '.duck-pad{position:absolute;left:50%;bottom:max(18px,env(safe-area-inset-bottom));transform:translateX(-50%);' +
        'display:flex;flex-direction:column;align-items:center;gap:8px;z-index:6;user-select:none;touch-action:none}' +
        '.duck-pad .row{display:flex;gap:8px}' +
        '.duck-pad button{width:60px;height:56px;border-radius:14px;border:2px solid rgba(255,255,255,.28);' +
        'background:rgba(20,28,34,.5);color:#eaf6ff;font-size:20px;backdrop-filter:blur(6px);cursor:pointer;' +
        '-webkit-tap-highlight-color:transparent;transition:background .1s,transform .1s}' +
        '.duck-pad button:active{background:rgba(15,181,166,.55);transform:scale(.94)}';
      document.head.appendChild(s);
    }
    container.appendChild(pad);
    pad.querySelectorAll('button').forEach((btn) => {
      const k = btn.getAttribute('data-k');
      const on = (e) => { e.preventDefault(); pressed[k] = 1; send(); };
      const off = (e) => { e.preventDefault(); pressed[k] = 0; send(); };
      btn.addEventListener('pointerdown', on);
      btn.addEventListener('pointerup', off);
      btn.addEventListener('pointerleave', off);
      btn.addEventListener('pointercancel', off);
    });
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener('resize', resize);

  return {
    worker, scene, camera, renderer,
    setCommand(vx, vy, wz) { worker.postMessage({ cmd: 'command', vx: vx || 0, vy: vy || 0, wz: wz || 0 }); },
    pause() { worker.postMessage({ cmd: 'pause' }); },
    resume() { worker.postMessage({ cmd: 'resume' }); },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      if (pad && pad.parentNode) pad.parentNode.removeChild(pad);
      worker.terminate();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  };
}
