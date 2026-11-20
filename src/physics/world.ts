import type Jolt from 'jolt-physics/wasm-compat';
import type { Circuit, CollisionMesh, Driver, RaceState, WheelLayout } from '../types';

export const STEP = 1 / 120;
export const factoryAssists = { tc: 3, abs: 2 } as const;
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
export interface Controls {
  throttle: number;
  brake: number;
  right: number;
  handbrake: number;
  draft: number;
}
const grip = { asphalt: 1.68, groove: 1.76, kerb: 1.45, grass: 0.78, gravel: 0.58 };
const referenceRadius = 0.33, bodyHeight = 0.402, springMin = 0.08, springMax = 0.18, restCompression = 0.03;
// Standalone/headless callers without a rig retain the original reference chassis.
const referenceWheel = (x: number, z: number) => ({
  x, y: bodyHeight + 0.08 - springMax + restCompression, z, radius: referenceRadius,
});
const referenceLayout: WheelLayout = [
  referenceWheel(-0.82, 1.27), referenceWheel(0.82, 1.27),
  referenceWheel(-0.82, -1.37), referenceWheel(0.82, -1.37),
];
const frontLoadShare = -referenceLayout[2].z / (referenceLayout[0].z - referenceLayout[2].z);

interface Car {
  body: Jolt.Body;
  vehicle: Jolt.VehicleConstraint;
  controller: Jolt.WheeledVehicleController;
  listener: Jolt.VehicleConstraintStepListener;
  contacts: Jolt.VehicleConstraintCallbacksJS;
  wheels: Jolt.WheelWV[];
  layout: WheelLayout;
  springLengths: number[];
  patchGrip: number[];
  steer: number;
  shiftCut: number;
  weatherGrip: number;
  gravelShare: number;
}

export async function createWorld(circuit: Circuit, meshes: CollisionMesh[]) {
  const { default: initJolt } = await import('jolt-physics/wasm-compat');
  const j = await initJolt();
  const cfg = new j.JoltSettings(),
    pairs = new j.ObjectLayerPairFilterTable(2),
    bp = new j.BroadPhaseLayerInterfaceTable(2, 2);
  pairs.EnableCollision(0, 1);
  pairs.EnableCollision(1, 1);
  for (const i of [0, 1]) {
    const l = new j.BroadPhaseLayer(i);
    bp.MapObjectToBroadPhaseLayer(i, l);
    j.destroy(l);
  }
  cfg.mObjectLayerPairFilter = pairs;
  cfg.mBroadPhaseLayerInterface = bp;
  cfg.mObjectVsBroadPhaseLayerFilter = new j.ObjectVsBroadPhaseLayerFilterTable(bp, 2, pairs, 2);
  cfg.mMaxWorkerThreads = 0;
  const world = new j.JoltInterface(cfg);
  j.destroy(cfg);
  const system = world.GetPhysicsSystem(),
    bodies = system.GetBodyInterface(),
    v = new j.Vec3(0, 0, 0),
    pos = new j.RVec3(0, 0, 0),
    rot = new j.Quat(0, 0, 0, 1);
  const fixed: Jolt.Body[] = [],
    cars: Car[] = [];
  const ground = new Map<number, CollisionMesh['kind']>();
  function createBody(shape: Jolt.ShapeSettings, moving: boolean, wall = false) {
    const result = shape.Create();
    if (result.HasError()) throw Error('Invalid Jolt collision geometry: ' + result.GetError().c_str());
    const settings = new j.BodyCreationSettings(
      result.Get(),
      pos,
      rot,
      moving ? j.EMotionType_Dynamic : j.EMotionType_Static,
      moving ? 1 : 0,
    );
    result.Clear();
    j.destroy(shape);
    settings.mFriction = wall ? 0.15 : 1;
    settings.mRestitution = wall ? 0.1 : 0;
    if (moving) {
      settings.mOverrideMassProperties = j.EOverrideMassProperties_CalculateInertia;
      settings.mMassPropertiesOverride.mMass = 1285;
      settings.mLinearDamping = 0.005;
      settings.mAngularDamping = 0.28;
      settings.mAllowSleeping = false;
    }
    const body = bodies.CreateBody(settings);
    j.destroy(settings);
    bodies.AddBody(body.GetID(), moving ? j.EActivation_Activate : j.EActivation_DontActivate);
    return body;
  }
  for (const mesh of meshes) {
    if (!mesh.indices.length) continue;
    const shape = new j.MeshShapeSettings(),
      vertices = shape.mTriangleVertices,
      triangles = shape.mIndexedTriangles;
    vertices.resize(mesh.positions.length / 3);
    for (let i = 0; i < vertices.size(); i++) {
      const f = vertices.at(i);
      f.x = mesh.positions[3 * i];
      f.y = mesh.positions[3 * i + 1];
      f.z = mesh.positions[3 * i + 2];
    }
    triangles.resize(mesh.indices.length / 3);
    for (let i = 0; i < triangles.size(); i++) {
      const t = triangles.at(i);
      for (let k = 0; k < 3; k++) t.set_mIdx(k, mesh.indices[i * 3 + k]);
      t.mMaterialIndex = 0;
      t.mUserData = 0;
    }
    shape.Sanitize();
    const body = createBody(shape, false, mesh.kind === 'wall');
    fixed.push(body);
    ground.set(j.getPointer(body), mesh.kind);
  }
  function pose(d: Driver, s: number, lateral: number) {
    const p = circuit.at(s, lateral);
    pos.Set(p.x, p.y + 0.409, p.z);
    rot.Set(0, Math.sin(p.yaw / 2), 0, Math.cos(p.yaw / 2));
    d.s = p.s;
    d.d = lateral;
    d.x = p.x;
    d.y = pos.GetY() - bodyHeight;
    d.z = p.z;
    d.yaw = p.yaw;
    d.pitch = d.roll = 0;
    d.speed = 0;
    d.steer = 0;
  }
  function add(d: Driver, s: number, lateral: number, layout: WheelLayout = referenceLayout) {
    pose(d, s, lateral);
    v.Set(0.91, 0.2, 2.11);
    const box = new j.BoxShapeSettings(v, 0.08);
    // Keep the tuned static axle loads when the donor's footprint is not
    // centred on its wheelbase. The box and visual origin stay where they are.
    const frontZ = (layout[0].z + layout[1].z) / 2, rearZ = (layout[2].z + layout[3].z) / 2;
    v.Set(0, -0.18, rearZ + (frontZ - rearZ) * frontLoadShare);
    const body = createBody(new j.OffsetCenterOfMassShapeSettings(v, box), true),
      vs = new j.VehicleConstraintSettings();
    const tangent = Math.min(...layout.map(h => h.y - h.radius)), springLengths: number[] = [];
    vs.mMaxPitchRollAngle = 0.68;
    for (let i = 0; i < 4; i++) {
      const front = i < 2,
        hub = layout[i],
        radiusScale = hub.radius / referenceRadius,
        preload = Math.min(springMin, hub.y - hub.radius - tangent),
        length = springMax - preload,
        w = new j.WheelSettingsWV();
      // A millimetre of authored tyre stagger must not twist an anti-roll bar
      // on flat ground. Move both travel stops and preload by the stagger, so
      // spring free length, travel and the rig's hub at 30 mm compression agree.
      v.Set(hub.x, hub.y - bodyHeight + length - restCompression, hub.z);
      w.mPosition = v;
      w.mMaxSteerAngle = front ? (28 * Math.PI) / 180 : 0;
      w.mRadius = hub.radius;
      w.mWidth = 0.3;
      w.mSuspensionMinLength = springMin - preload;
      w.mSuspensionMaxLength = length;
      w.mSuspensionPreloadLength = preload;
      springLengths.push(w.mSuspensionMaxLength);
      w.mSuspensionSpring.mFrequency = front ? 2.85 : 3.1;
      w.mSuspensionSpring.mDamping = 0.7;
      // Keep the existing brake force (torque/r) and effective rolling mass (I/r²).
      w.mInertia *= radiusScale * radiusScale;
      w.mMaxBrakeTorque = (front ? 3700 : 2550) * radiusScale;
      w.mMaxHandBrakeTorque = (front ? 0 : 3300) * radiusScale;
      for (const [curve, knee] of [[w.mLongitudinalFriction, 0.11], [w.mLateralFriction, 5.5]] as const) {
        curve.Clear();
        curve.AddPoint(0, 0.82);
        curve.AddPoint(knee, 1);
        curve.AddPoint(knee * 6, 0.84);
      }
      vs.mWheels.push_back(w);
    }
    const cs = new j.WheeledVehicleControllerSettings();
    vs.mController = cs;
    cs.mEngine.mMaxTorque = 665;
    cs.mEngine.mMinRPM = 1650;
    cs.mEngine.mMaxRPM = 8500;
    cs.mEngine.mNormalizedTorque.Clear();
    for (const [x, y] of [
      [0, 0.64],
      [0.32, 0.86],
      [0.72, 1],
      [1, 0.88],
    ])
      cs.mEngine.mNormalizedTorque.AddPoint(x, y);
    const tr = cs.mTransmission;
    tr.mMode = j.ETransmissionMode_Manual;
    tr.mSwitchTime = 0.095;
    tr.mClutchReleaseTime = 0.07;
    tr.mClutchStrength = 16;
    tr.mGearRatios.clear();
    for (const ratio of [3.2, 2.34, 1.81, 1.48, 1.26, 1.08]) tr.mGearRatios.push_back(ratio);
    const diff = new j.VehicleDifferentialSettings();
    diff.mLeftWheel = 2;
    diff.mRightWheel = 3;
    // Match road speed per engine RPM at the driven axle, not wheel RPM across donors.
    diff.mDifferentialRatio = 3.43 * ((layout[2].radius + layout[3].radius) / (2 * referenceRadius));
    diff.mLimitedSlipRatio = 2.2;
    cs.mDifferentials.clear();
    cs.mDifferentials.push_back(diff);
    j.destroy(diff);
    for (const axle of [0, 2]) {
      const bar = new j.VehicleAntiRollBar();
      bar.mLeftWheel = axle;
      bar.mRightWheel = axle + 1;
      bar.mStiffness = axle === 0 ? 11500 : 9000;
      vs.mAntiRollBars.push_back(bar);
      j.destroy(bar);
    }
    const vehicle = new j.VehicleConstraint(body, vs);
    j.destroy(vs);
    vehicle.SetVehicleCollisionTester(new j.VehicleCollisionTesterRay(1));
    system.AddConstraint(vehicle);
    const listener = new j.VehicleConstraintStepListener(vehicle);
    system.AddStepListener(listener);
    const controller = j.castObject(vehicle.GetController(), j.WheeledVehicleController);
    controller.GetTransmission().Set(1, 1);
    const wheels = Array.from({ length: 4 }, (_, i) => j.castObject(vehicle.GetWheel(i), j.WheelWV));
    const contacts = new j.VehicleConstraintCallbacksJS();
    const hitX = new Float64Array(4).fill(NaN), hitZ = new Float64Array(4);
    const car: Car = {
      body, vehicle, controller, listener, contacts, wheels, layout, springLengths,
      patchGrip: [0, 0, 0, 0], steer: 0, shiftCut: 0, weatherGrip: 1, gravelShare: 0,
    };
    // Jolt calls longitudinal then lateral after this step's ray test, before
    // solving either impulse. No stale contact on landing or after a teleport.
    contacts.GetCombinedFriction = (i, dir, tire, other) => {
      if (dir === j.ETireFrictionDirection_Longitudinal) {
        const kind = ground.get(other);
        if (kind === 'road' || kind === 'runoff') {
          const hit = wheels[i].GetContactPosition(), x = hit.GetX(), z = hit.GetZ();
          // Only project moving hits. Don't quantise or hold a stale surface at
          // the shoulder: one wheel can cross the material line in a single tick.
          if (x !== hitX[i] || z !== hitZ[i]) {
            car.patchGrip[i] = grip[circuit.nearest(x, z).surface];
            hitX[i] = x;
            hitZ[i] = z;
          }
        } else {
          hitX[i] = NaN;
          car.patchGrip[i] = kind === 'kerb' ? grip.kerb : Math.sqrt(j.wrapPointer(other, j.Body).GetFriction());
        }
      }
      return Math.sqrt(tire) * car.patchGrip[i] * car.weatherGrip;
    };
    contacts.OnPreStepCallback = contacts.OnPostCollideCallback = contacts.OnPostStepCallback = () => {};
    contacts.SetVehicleConstraint(vehicle);
    cars.push(car);
  }
  function shift(d: Driver, direction: number) {
    const c = cars[d.id];
    if (!c || c.shiftCut > 0) return;
    const tr = c.controller.GetTransmission(),
      from = tr.GetCurrentGear(),
      to = clamp(from + direction, 1, 6);
    if (to === from) return;
    const ratios = tr.mGearRatios,
      nextRpm = (d.rpm * ratios.at(to - 1)) / ratios.at(from - 1);
    if (direction < 0 && nextRpm > 8420) return;
    tr.Set(to, 1);
    c.shiftCut = 0.095;
    if (direction < 0) c.controller.GetEngine().SetCurrentRPM(nextRpm);
  }
  function control(d: Driver, input: Controls, state: RaceState) {
    const c = cars[d.id],
      speed = d.speed,
      ctrl = c.controller;
    c.weatherGrip = state.settings.weather === 'damp' ? 0.91 : 1;
    const automatic = d.id !== 0 || state.autopilot || state.settings.transmission === 'auto';
    if (automatic) {
      if (d.rpm > 8080) shift(d, 1);
      else if (d.rpm < 4590 && d.gear > 1) shift(d, -1);
    }
    c.shiftCut = Math.max(0, c.shiftCut - STEP);
    const slip = Math.max(c.wheels[2].mLongitudinalSlip, c.wheels[3].mLongitudinalSlip);
    const { tc, abs } = d.id === 0 ? state : factoryAssists;
    d.tcActive = tc > 0 && speed > 4 && input.throttle > 0.1 && slip > 0.28 - 0.025 * tc;
    d.absActive = abs > 0 && speed > 3 && input.brake > 0.2 &&
      Math.max(slip, c.wheels[0].mLongitudinalSlip, c.wheels[1].mLongitudinalSlip) > 0.32 - 0.05 * abs;
    d.throttle = input.throttle * (c.shiftCut > 0 ? 0 : d.tcActive ? 0.68 : 1);
    d.brake = input.brake * (d.absActive ? 0.72 : 1);
    const target = clamp(input.right, -1, 1);
    c.steer += clamp(target - c.steer, -STEP * 3.8, STEP * 3.8);
    ctrl.SetDriverInput(d.throttle, -c.steer, d.brake, input.handbrake);
    const down = 0.5 * 1.225 * 3.65 * speed * speed,
      drag =
        0.5 * 1.225 * 0.72 * speed * speed * (1 - input.draft * 0.23) + c.gravelShare * 1000;
    const velocity = c.body.GetLinearVelocity(),
      ratio = drag / Math.max(1, speed);
    v.Set(-velocity.GetX() * ratio, -down, -velocity.GetZ() * ratio);
    c.body.AddForce(v);
    // Offset the aero centre behind the CoM: 42% of vertical load on the front axle.
    v.Set(-Math.cos(d.yaw) * 0.21 * down, 0, Math.sin(d.yaw) * 0.21 * down);
    c.body.AddTorque(v);
  }
  function read(d: Driver) {
    const c = cars[d.id],
      p = c.body.GetPosition(),
      q = c.body.GetRotation(),
      vx = c.body.GetLinearVelocity();
    d.speed = vx.Length();
    const x = q.GetX(),
      y = q.GetY(),
      z = q.GetZ(),
      w = q.GetW();
    // Transform the rig's road origin on the body's local up axis. Subtracting
    // world Y instead displaces every visual wheel sideways on banked kerbs.
    d.x = p.GetX() - bodyHeight * 2 * (x * y - w * z);
    d.y = p.GetY() - bodyHeight * (1 - 2 * (x * x + z * z));
    d.z = p.GetZ() - bodyHeight * 2 * (y * z + w * x);
    d.yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y));
    d.pitch = Math.asin(clamp(2 * (w * x - y * z), -1, 1));
    d.roll = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
    const n = circuit.nearest(d.x, d.z);
    let ds = n.s - d.s;
    if (ds > circuit.length / 2) ds -= circuit.length;
    if (ds < -circuit.length / 2) ds += circuit.length;
    d.distance += ds;
    d.s = n.s;
    d.d = n.d;
    d.surface = n.surface;
    d.gear = c.controller.GetTransmission().GetCurrentGear();
    d.rpm = c.controller.GetEngine().GetCurrentRPM();
    d.steer = c.wheels[0].GetSteerAngle();
    d.slip = 0;
    let totalLoad = 0, gravelLoad = 0;
    for (let i = 0; i < 4; i++) {
      const wheel = c.wheels[i];
      d.wheelAngles[i] = wheel.GetRotationAngle();
      d.wheelCompressionM[i] = c.springLengths[i] - wheel.GetSuspensionLength();
      let tireWork = 0, brakingForce = 0;
      if (wheel.HasContact()) {
        const load = Math.max(0, wheel.GetSuspensionLambda());
        totalLoad += load;
        if (c.patchGrip[i] === grip.gravel) gravelLoad += load;
        d.slip = Math.max(d.slip, wheel.mLongitudinalSlip);
        // [Value] getters use binding-owned slots. Sub modifies the returned
        // velocity copy, not the body; consume it before asking for the next one.
        const relative = bodies.GetPointVelocity(c.body.GetID(), wheel.GetContactPosition());
        relative.Sub(wheel.GetContactPointVelocity());
        const along = relative.Dot(wheel.GetContactLongitudinal());
        const side = relative.Dot(wheel.GetContactLateral());
        const longImpulse = Math.abs(wheel.GetLongitudinalLambda());
        // Jolt's tangential impulses are already limited by this tyre's normal
        // load. Impulse [N s] × sliding speed [m/s] gives dissipated joules.
        tireWork = longImpulse * Math.abs(c.layout[i].radius * wheel.GetAngularVelocity() - along)
          + Math.abs(wheel.GetLateralLambda() * side);
        if (d.brake > 0) brakingForce = longImpulse / STEP;
      }
      const t = d.brakeTempC[i],
        radiated = 0.25 * 5.67e-8 * ((t + 273.15) ** 4 - 300.15 ** 4);
      // Effective hot friction ring: 3.7 kg × 500 J/(kg K). Telemetry is
      // surface temperature, not the slower thermal response of the entire hub.
      d.brakeTempC[i] +=
        STEP * ((brakingForce * d.speed * 0.91 - radiated) / 1850 - (t - 27) * (0.001 + 0.00025 * d.speed));
      // Half the patch work goes into an effective 8 kg × 1500 J/(kg K) tread.
      d.tireTempC[i] += tireWork / 24000 - STEP * (d.tireTempC[i] - 32) * 0.0019;
    }
    d.wheelAngle = d.wheelAngles[0];
    c.gravelShare = totalLoad > 0 ? gravelLoad / totalLoad : 0;
  }
  function reset(d: Driver, s = d.s, lateral = 0) {
    const c = cars[d.id];
    pose(d, s, lateral);
    bodies.SetPositionAndRotation(c.body.GetID(), pos, rot, j.EActivation_Activate);
    v.Set(0, 0, 0);
    bodies.SetLinearAndAngularVelocity(c.body.GetID(), v, v);
    c.controller.GetTransmission().Set(1, 1);
    for (const w of c.wheels) {
      w.SetAngularVelocity(0);
      w.SetRotationAngle(0);
    }
    d.wheelAngles.fill(0);
    d.wheelAngle = 0;
    c.steer = 0;
    c.shiftCut = 0;
    c.gravelShare = 0;
    d.slip = 0;
  }
  function clear() {
    for (const c of cars) {
      system.RemoveStepListener(c.listener);
      j.destroy(c.listener);
      system.RemoveConstraint(c.vehicle);
      j.destroy(c.contacts);
      bodies.RemoveBody(c.body.GetID());
      bodies.DestroyBody(c.body.GetID());
    }
    cars.length = 0;
  }
  function dispose() {
    clear();
    for (const b of fixed) {
      bodies.RemoveBody(b.GetID());
      bodies.DestroyBody(b.GetID());
    }
    for (const a of [v, pos, rot, world]) j.destroy(a);
  }
  return {
    add,
    control,
    shift,
    reset,
    read,
    clear,
    dispose,
    step: () => world.Step(STEP, 1),
    freeMemory: () => j.JoltInterface.prototype.sGetFreeMemory(),
  };
}
