// Microduck physics + policy worker.
//   physics: MuJoCo (@mujoco/mujoco WASM, single-thread), 200 Hz (5 ms step)
//   policy : velstand.onnx via onnxruntime-web, 50 Hz, 61-dim obs -> 14 position targets
// Streams geom world-transforms to the renderer each frame. Z-up (MuJoCo).
import loadMujoco from './vendor/mujoco.js';
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.wasm.min.mjs';

ort.env.wasm.numThreads = 1;            // single-thread -> no SharedArrayBuffer / COOP-COEP needed
ort.env.wasm.simd = true;
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';

const TIMESTEP = 0.005;                 // 5 ms physics
const CTRL_DECIM = 4;                   // 200 Hz / 50 Hz
const MESH = 7;                         // mjGEOM_MESH
const DEG = Math.PI / 180;
// velstand default pose (deg), model/actuator order
const DEFAULT_DEG = [0.0, -4.984733, -26.241467, -0.286479, 25.954988, 19.996227, 19.996227,
  0.0, 0.0, 0.0, 4.984733, 26.241467, 0.286479, -25.954988];

let mj, model, data, session, inName, outName;
let nq, nu, ngeom, baseBid = 0;
let order = [];                         // render order -> geom index
const qadr = [], vadr = [], defRad = new Float32Array(14);
const obs = new Float32Array(61);
const prevAction = new Float32Array(14);
const twist = new Float32Array(3);      // vx, vy, wz  (user command)
const headCmd = new Float32Array(4);    // neutral
const bodyCmd = new Float32Array(6);    // neutral
let stepCount = 0, running = false, acc = 0, last = 0, busy = false;

function copy(arr, start, len) { const o = new Float64Array(len); for (let i = 0; i < len; i++) o[i] = arr[start + i]; return o; }

async function writeModelFiles() {
  const files = await (await fetch('./model/files.json')).json();
  const bufs = await Promise.all(files.map((f) => fetch('./model/' + f).then((r) => r.arrayBuffer())));
  files.forEach((f, i) => {
    const path = '/m/' + f;
    mj.FS.mkdirTree(path.substring(0, path.lastIndexOf('/')));
    mj.FS.writeFile(path, new Uint8Array(bufs[i]));
  });
}

function buildMaps() {
  const trn = model.actuator_trnid, qa = model.jnt_qposadr, va = model.jnt_dofadr;
  for (let i = 0; i < nu; i++) {
    const j = trn[2 * i];
    qadr[i] = qa[j]; vadr[i] = va[j]; defRad[i] = DEFAULT_DEG[i] * DEG;
  }
}

function buildSpec() {
  // Non-indexed position per face corner. The renderer re-derives normals with a crease angle
  // (toCreasedNormals): gentle curves (servos, shells) shade smooth, real edges stay sharp.
  const type = model.geom_type, dataid = model.geom_dataid, rgba = model.geom_rgba, group = model.geom_group;
  const vadrM = model.mesh_vertadr, fadrM = model.mesh_faceadr, fnum = model.mesh_facenum;
  const mvert = model.mesh_vert, mface = model.mesh_face;
  const geoms = []; order = [];
  for (let g = 0; g < ngeom; g++) {
    if (type[g] !== MESH) continue;
    if (group[g] === 3) continue;                 // skip collision duplicates (group 3)
    const did = dataid[g]; if (did < 0) continue;
    const fn = fnum[did], va = vadrM[did], fa = fadrM[did];
    const pos = new Float32Array(fn * 9);
    let p = 0;
    for (let f = 0; f < fn; f++) {
      for (let c = 0; c < 3; c++) {
        const vb = (va + mface[(fa + f) * 3 + c]) * 3;
        pos[p] = mvert[vb]; pos[p + 1] = mvert[vb + 1]; pos[p + 2] = mvert[vb + 2];
        p += 3;
      }
    }
    geoms.push({ pos, rgba: [rgba[4 * g], rgba[4 * g + 1], rgba[4 * g + 2], rgba[4 * g + 3]] });
    order.push(g);
  }
  return geoms;
}

// rotate world vector v by the conjugate of base quat (w,x,y,z) -> express v in base frame
function worldToBase(w, x, y, z, vx, vy, vz, out, o) {
  const qx = -x, qy = -y, qz = -z;
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  out[o] = vx + w * tx + (qy * tz - qz * ty);
  out[o + 1] = vy + w * ty + (qz * tx - qx * tz);
  out[o + 2] = vz + w * tz + (qx * ty - qy * tx);
}

function buildObs() {
  const q = data.qpos, v = data.qvel;
  obs[0] = v[3]; obs[1] = v[4]; obs[2] = v[5];                 // base_ang_vel (base frame)
  worldToBase(q[3], q[4], q[5], q[6], 0, 0, -1, obs, 3);        // projected_gravity
  let k = 6;
  for (let i = 0; i < 14; i++) obs[k++] = q[qadr[i]] - defRad[i];   // joint_pos
  for (let i = 0; i < 14; i++) obs[k++] = v[vadr[i]];              // joint_vel
  for (let i = 0; i < 14; i++) obs[k++] = prevAction[i];          // actions
  obs[k++] = twist[0]; obs[k++] = twist[1]; obs[k++] = twist[2];  // command: twist
  for (let i = 0; i < 4; i++) obs[k++] = headCmd[i];              // head_command
  for (let i = 0; i < 6; i++) obs[k++] = bodyCmd[i];              // body_command
}

async function control() {
  buildObs();
  const res = await session.run({ [inName]: new ort.Tensor('float32', obs, [1, 61]) });
  const a = res[outName].data;
  for (let i = 0; i < 14; i++) { prevAction[i] = a[i]; data.ctrl[i] = defRad[i] + a[i]; }
}

function postFrame() {
  const xpos = data.geom_xpos, xmat = data.geom_xmat, n = order.length;
  const P = new Float32Array(n * 3), Mt = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const g = order[i];
    P[i * 3] = xpos[g * 3]; P[i * 3 + 1] = xpos[g * 3 + 1]; P[i * 3 + 2] = xpos[g * 3 + 2];
    for (let j = 0; j < 9; j++) Mt[i * 9 + j] = xmat[g * 9 + j];
  }
  const bp = data.xpos, base = [bp[3 * baseBid], bp[3 * baseBid + 1], bp[3 * baseBid + 2]];
  postMessage({ type: 'frame', pos: P, mat: Mt, base, t: data.time }, [P.buffer, Mt.buffer]);
}

async function loop() {
  if (!running || busy) return;
  busy = true;
  const now = performance.now();
  if (!last) last = now;
  acc += (now - last) / 1000; last = now;
  let steps = Math.floor(acc / TIMESTEP); if (steps > 8) steps = 8; acc -= steps * TIMESTEP;
  for (let s = 0; s < steps; s++) {
    if (stepCount % CTRL_DECIM === 0) await control();
    mj.mj_step(model, data);
    stepCount++;
  }
  postFrame();
  busy = false;
  if (running) setTimeout(loop, 16);
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.cmd === 'init') {
    try {
      mj = await loadMujoco();
      await writeModelFiles();
      model = mj.MjModel.from_xml_path('/m/scene_backlash.xml');
      model.opt.timestep = TIMESTEP;
      data = new mj.MjData(model);
      nq = model.nq; nu = model.nu; ngeom = model.ngeom;
      baseBid = model.jnt_bodyid[0];        // free-joint base body
      buildMaps();
      const k = model.nkey > 1 ? 1 : 0;                 // STAND
      data.qpos.set(copy(model.key_qpos, k * nq, nq));
      data.qvel.fill(0);
      for (let i = 0; i < 14; i++) data.ctrl[i] = defRad[i];
      mj.mj_forward(model, data);
      postMessage({ type: 'status', msg: 'loading policy' });
      const onnx = await (await fetch('./policy/velstand.onnx')).arrayBuffer();
      session = await ort.InferenceSession.create(onnx, { executionProviders: ['wasm'] });
      inName = session.inputNames[0]; outName = session.outputNames[0];
      const geoms = buildSpec();
      const transfer = []; for (const g of geoms) transfer.push(g.pos.buffer);
      postMessage({ type: 'ready', geoms }, transfer);
      running = true; last = 0; loop();
    } catch (e) {
      postMessage({ type: 'error', msg: String((e && e.stack) || e) });
    }
  } else if (m.cmd === 'command') {
    twist[0] = m.vx || 0; twist[1] = m.vy || 0; twist[2] = m.wz || 0;
  } else if (m.cmd === 'pause') { running = false; last = 0; }
  else if (m.cmd === 'resume') { if (!running) { running = true; last = 0; loop(); } }
};
