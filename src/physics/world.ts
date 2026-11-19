import initJolt from 'jolt-physics/wasm-compat';
import type Jolt from 'jolt-physics/wasm-compat';
import type { Circuit, CollisionMesh, Driver, RaceState } from '../types';

export const STEP = 1 / 120;
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
type J = Awaited<ReturnType<typeof initJolt>>;
interface Car {
  body: Jolt.Body;
  vehicle: Jolt.VehicleConstraint;
  controller: Jolt.WheeledVehicleController;
  listener: Jolt.VehicleConstraintStepListener;
  wheels: Jolt.WheelWV[];
  steer: number;
  shiftCut: number;
  friction: number;
}

export async function createWorld(circuit: Circuit, meshes: CollisionMesh[]) {
  const j: J = await initJolt();
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
    fixed.push(createBody(shape, false, mesh.kind === 'wall'));
  }
  function pose(d: Driver, s: number, lateral: number) {
    const p = circuit.at(s, lateral);
    pos.Set(p.x, p.y + 0.409, p.z);
    rot.Set(0, Math.sin(p.yaw / 2), 0, Math.cos(p.yaw / 2));
    d.s = p.s;
    d.d = lateral;
    d.x = p.x;
    d.y = p.y;
    d.z = p.z;
    d.yaw = p.yaw;
    d.speed = 0;
    d.steer = 0;
  }
  function add(d: Driver, s: number, lateral: number) {
    pose(d, s, lateral);
    v.Set(0.91, 0.2, 2.11);
    const box = new j.BoxShapeSettings(v, 0.08);
    v.Set(0, -0.18, 0);
    const body = createBody(new j.OffsetCenterOfMassShapeSettings(v, box), true),
      vs = new j.VehicleConstraintSettings();
    vs.mMaxPitchRollAngle = 0.68;
    for (let i = 0; i < 4; i++) {
      const front = i < 2,
        w = new j.WheelSettingsWV();
      v.Set(i % 2 === 0 ? -0.82 : 0.82, 0.08, front ? 1.27 : -1.37);
      w.mPosition = v;
      w.mMaxSteerAngle = front ? (28 * Math.PI) / 180 : 0;
      w.mRadius = 0.33;
      w.mWidth = 0.3;
      w.mSuspensionMinLength = 0.08;
      w.mSuspensionMaxLength = 0.18;
      w.mSuspensionSpring.mFrequency = front ? 2.85 : 3.1;
      w.mSuspensionSpring.mDamping = 0.7;
      w.mMaxBrakeTorque = front ? 3700 : 2550;
      w.mMaxHandBrakeTorque = front ? 0 : 3300;
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
    diff.mDifferentialRatio = 3.43;
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
    cars.push({
      body,
      vehicle,
      controller,
      listener,
      wheels: Array.from({ length: 4 }, (_, i) => j.castObject(vehicle.GetWheel(i), j.WheelWV)),
      steer: 0,
      shiftCut: 0,
      friction: 0,
    });
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
    const mu = grip[d.surface] * (state.settings.weather === 'damp' ? 0.91 : 1);
    if (mu !== c.friction) {
      for (const wheel of c.wheels) {
        const w = wheel.GetSettings();
        for (const [curve, knee] of [
          [w.mLongitudinalFriction, 0.11],
          [w.mLateralFriction, 5.5],
        ] as const) {
          curve.Clear();
          curve.AddPoint(0, mu * mu * 0.82);
          curve.AddPoint(knee, mu * mu);
          curve.AddPoint(knee * 6, mu * mu * 0.84);
        }
      }
      c.friction = mu;
    }
    const automatic = d.id !== 0 || state.autopilot || state.settings.transmission === 'auto';
    if (automatic) {
      if (d.rpm > 8080) shift(d, 1);
      else if (d.rpm < 4590 && d.gear > 1) shift(d, -1);
    }
    c.shiftCut = Math.max(0, c.shiftCut - STEP);
    const slip = Math.max(c.wheels[2].mLongitudinalSlip, c.wheels[3].mLongitudinalSlip);
    d.tcActive = state.tc > 0 && speed > 4 && input.throttle > 0.1 && slip > 0.28 - 0.025 * state.tc;
    d.absActive =
      state.abs > 0 &&
      speed > 3 &&
      input.brake > 0.2 &&
      c.wheels.some((w) => w.mLongitudinalSlip > 0.32 - 0.05 * state.abs);
    d.throttle = input.throttle * (c.shiftCut > 0 ? 0 : d.tcActive ? 0.68 : 1);
    d.brake = input.brake * (d.absActive ? 0.72 : 1);
    const target = clamp(input.right, -1, 1);
    c.steer += clamp(target - c.steer, -STEP * 3.8, STEP * 3.8);
    ctrl.SetDriverInput(d.throttle, -c.steer, d.brake, input.handbrake);
    const down = 0.5 * 1.225 * 3.65 * speed * speed,
      drag =
        0.5 * 1.225 * 0.72 * speed * speed * (1 - input.draft * 0.23) + (d.surface === 'gravel' ? 1000 : 0);
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
    d.x = p.GetX();
    d.y = p.GetY() - 0.402;
    d.z = p.GetZ();
    d.speed = vx.Length();
    const x = q.GetX(),
      y = q.GetY(),
      z = q.GetZ(),
      w = q.GetW();
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
    d.wheelAngle = c.wheels[0].GetRotationAngle();
    d.steer = c.wheels[0].GetSteerAngle();
    d.slip = 0;
    for (let i = 0; i < 4; i++) {
      const wheel = c.wheels[i];
      d.wheelCompressionM[i] = 0.18 - wheel.GetSuspensionLength();
      d.slip = Math.max(d.slip, Math.abs(wheel.mLongitudinalSlip));
      const brakingForce = d.brake > 0 ? Math.abs(wheel.GetLongitudinalLambda()) / STEP : 0;
      const t = d.brakeTempC[i],
        radiated = 0.25 * 5.67e-8 * ((t + 273.15) ** 4 - 300.15 ** 4);
      // Effective hot friction ring: 3.7 kg × 500 J/(kg K). Telemetry is
      // surface temperature, not the slower thermal response of the entire hub.
      d.brakeTempC[i] +=
        STEP * ((brakingForce * d.speed * 0.91 - radiated) / 1850 - (t - 27) * (0.001 + 0.00025 * d.speed));
      d.tireTempC[i] +=
        STEP * (Math.min(0.55, d.slip * 0.15) * d.speed * 0.035 - (d.tireTempC[i] - 32) * 0.0019);
    }
  }
  function reset(d: Driver, s = d.s, lateral = 0) {
    const c = cars[d.id];
    pose(d, s, lateral);
    bodies.SetPositionAndRotation(c.body.GetID(), pos, rot, j.EActivation_Activate);
    v.Set(0, 0, 0);
    bodies.SetLinearAndAngularVelocity(c.body.GetID(), v, v);
    c.controller.GetTransmission().Set(1, 1);
    for (const w of c.wheels) w.SetAngularVelocity(0);
    c.steer = 0;
    c.shiftCut = 0;
  }
  function clear() {
    for (const c of cars) {
      system.RemoveStepListener(c.listener);
      j.destroy(c.listener);
      system.RemoveConstraint(c.vehicle);
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
