import type Jolt from 'jolt-physics/wasm-compat';
import type { Circuit, CollisionMesh, Driver, RaceState, TireCompound, Weather, WheelLayout } from '../types';
import { PIT_SPEED_LIMIT_MS } from '../track/circuit';
import { TrackSurfaceGrid, type SurfaceSample } from '../track/surfaceState';
import { COMPOUNDS, computeWheelGrip } from './tires';

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
const referenceRadius = 0.33,
  bodyHeight = 0.402,
  springMin = 0.08,
  springMax = 0.18,
  restCompression = 0.03;
const BASE_CHASSIS_MASS_KG = 1285;
const FUEL_KG_PER_L = 0.75;
// Standalone/headless callers without a rig retain the original reference chassis.
const referenceWheel = (x: number, z: number) => ({
  x,
  y: bodyHeight + 0.08 - springMax + restCompression,
  z,
  radius: referenceRadius,
});
const referenceLayout: WheelLayout = [
  referenceWheel(-0.82, 1.27),
  referenceWheel(0.82, 1.27),
  referenceWheel(-0.82, -1.37),
  referenceWheel(0.82, -1.37),
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
  patchIsGravel: boolean[];
  steer: number;
  shiftCut: number;
  gravelShare: number;
  compound: TireCompound;
  tireTemp: number[];
  tireWear: [number, number, number, number];
  speed: number;
  prevSpeed: number;
  weather: Weather;
}

const drySample: SurfaceSample = { wetness: 0, rubberGrip: 0.35, dryingGroove: 0, marbles: 0 };

export async function createWorld(
  circuit: Circuit,
  meshes: CollisionMesh[],
  surfaceGrid?: TrackSurfaceGrid,
) {
  const grid = surfaceGrid ?? (circuit.samples.length > 0 ? new TrackSurfaceGrid(circuit) : undefined);
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
      settings.mMassPropertiesOverride.mMass = BASE_CHASSIS_MASS_KG;
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
    const body = createBody(shape, false, mesh.kind === 'wall' || mesh.kind === 'pitWall');
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
    const frontZ = (layout[0].z + layout[1].z) / 2,
      rearZ = (layout[2].z + layout[3].z) / 2;
    v.Set(0, -0.18, rearZ + (frontZ - rearZ) * frontLoadShare);
    const body = createBody(new j.OffsetCenterOfMassShapeSettings(v, box), true),
      vs = new j.VehicleConstraintSettings();
    const tangent = Math.min(...layout.map((h) => h.y - h.radius)),
      springLengths: number[] = [];
    vs.mMaxPitchRollAngle = 0.68;
    for (let i = 0; i < 4; i++) {
      const front = i < 2,
        hub = layout[i],
        radiusScale = hub.radius / referenceRadius,
        preload = Math.min(springMin, hub.y - hub.radius - tangent),
        length = springMax - preload,
        w = new j.WheelSettingsWV();
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
      w.mInertia *= radiusScale * radiusScale;
      w.mMaxBrakeTorque = (front ? 3700 : 2550) * radiusScale;
      w.mMaxHandBrakeTorque = (front ? 0 : 3300) * radiusScale;
      for (const [curve, knee] of [
        [w.mLongitudinalFriction, 0.11],
        [w.mLateralFriction, 5.5],
      ] as const) {
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
    tr.mSwitchTime = 0.045; // Crisp 45 ms GT3 sequential flat-shift ignition cut
    tr.mClutchReleaseTime = 0.045;
    tr.mClutchStrength = 18;
    tr.mGearRatios.clear();
    for (const ratio of [3.2, 2.34, 1.81, 1.48, 1.26, 1.08]) tr.mGearRatios.push_back(ratio);
    const diff = new j.VehicleDifferentialSettings();
    diff.mLeftWheel = 2;
    diff.mRightWheel = 3;
    diff.mDifferentialRatio = 3.43 * ((layout[2].radius + layout[3].radius) / (2 * referenceRadius));
    // 1.5-way clutch-pack LSD baseline locking ratio (modulated dynamically on power/coast)
    diff.mLimitedSlipRatio = 1.95;
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
    const hitX = new Float64Array(4).fill(NaN),
      hitZ = new Float64Array(4);
    const nearScratch = { s: 0, d: 0, surface: 'asphalt' as Driver['surface'] };
    const sampleScratch: SurfaceSample = { wetness: 0, rubberGrip: 0.35, dryingGroove: 0, marbles: 0 };
    const car: Car = {
      body,
      vehicle,
      controller,
      listener,
      contacts,
      wheels,
      layout,
      springLengths,
      patchGrip: [1.65, 1.65, 1.65, 1.65],
      patchIsGravel: [false, false, false, false],
      steer: 0,
      shiftCut: 0,
      gravelShare: 0,
      compound: d.compound,
      tireTemp: d.tireTempC,
      tireWear: d.tireWear,
      speed: 0,
      prevSpeed: 0,
      weather: 'golden',
    };

    // Per-wheel 120 Hz Pacejka + 3-compound + live TrackSurfaceGrid friction callback
    contacts.GetCombinedFriction = (i, dir, tire, other) => {
      if (dir === j.ETireFrictionDirection_Longitudinal) {
        const kind = ground.get(other);
        const w = wheels[i];
        const comp = springLengths[i] - w.GetSuspensionLength();
        const slipMag = Math.hypot(w.mLongitudinalSlip, w.mLateralSlip * 0.12);
        if (kind === 'road' || kind === 'runoff' || kind === 'pit' || kind === 'kerb') {
          const hit = w.GetContactPosition(),
            x = hit.GetX(),
            z = hit.GetZ();
          let surf: Driver['surface'] = kind === 'kerb' ? 'kerb' : kind === 'pit' ? 'pit' : 'asphalt';
          let sPos = 0,
            dPos = 0,
            hw = 8;
          if (kind === 'road' || kind === 'runoff' || kind === 'kerb') {
            // Skip redundant nearest() when wheel is stationary (grid lights / parked)
            if (x !== hitX[i] || z !== hitZ[i]) {
              const near = circuit.nearestToRef ? circuit.nearestToRef(x, z, nearScratch) : circuit.nearest(x, z);
              nearScratch.s = near.s;
              nearScratch.d = near.d;
              nearScratch.surface = near.surface;
              hitX[i] = x;
              hitZ[i] = z;
            }
            surf = kind === 'kerb' ? 'kerb' : nearScratch.surface;
            sPos = nearScratch.s;
            dPos = nearScratch.d;
            hw = circuit.samples.length > 0 ? circuit.samples[Math.floor(sPos) % circuit.samples.length]?.halfWidth ?? 8 : 8;
          }
          if (grid) {
            grid.sampleToRef(sPos, dPos, hw, sampleScratch);
          } else {
            sampleScratch.wetness = car.weather === 'rain' ? 0.85 : car.weather === 'damp' ? 0.45 : 0;
            sampleScratch.rubberGrip = drySample.rubberGrip;
            sampleScratch.dryingGroove = 0;
            sampleScratch.marbles = 0;
          }
          car.patchIsGravel[i] = surf === 'gravel';
          car.patchGrip[i] = computeWheelGrip(
            car.compound,
            surf,
            sampleScratch,
            car.tireTemp[i] ?? 75,
            car.tireWear[i] ?? 1,
            car.speed,
            comp,
            slipMag,
          );
        } else {
          hitX[i] = NaN;
          car.patchIsGravel[i] = false;
          car.patchGrip[i] = Math.sqrt(j.wrapPointer(other, j.Body).GetFriction());
        }
      }
      return Math.sqrt(tire) * car.patchGrip[i];
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
    c.shiftCut = 0.045; // 45 ms flat-shift cut
    if (direction < 0) c.controller.GetEngine().SetCurrentRPM(nextRpm);
  }

  function control(d: Driver, input: Controls, state: RaceState) {
    const c = cars[d.id],
      speed = d.speed,
      ctrl = c.controller;
    c.compound = d.compound;
    c.tireTemp = d.tireTempC;
    c.tireWear = d.tireWear;
    c.speed = speed;
    if (grid && !surfaceGrid && c.weather !== state.settings.weather) {
      grid.setWeather(state.settings.weather);
    }
    c.weather = state.settings.weather;

    // Stationary air-jack pit stop locks brakes & zeroes throttle cleanly
    if (d.pitState === 'servicing') {
      d.throttle = 0;
      d.brake = 1;
      d.tcActive = false;
      d.absActive = false;
      ctrl.SetDriverInput(0, 0, 1, 1);
      return;
    }

    const automatic = d.id !== 0 || state.autopilot || state.settings.transmission === 'auto';
    if (automatic) {
      if (d.rpm > 8080) shift(d, 1);
      else if (d.rpm < 4590 && d.gear > 1) shift(d, -1);
    }
    c.shiftCut = Math.max(0, c.shiftCut - STEP);

    // 1.5-way clutch-pack LSD locking torque bias (stronger under power than coast)
    const diffSettings = ctrl.GetDifferentials().at(0);
    if (diffSettings) {
      diffSettings.mLimitedSlipRatio = input.throttle > 0.15 ? 2.25 : 1.55;
    }

    const slip = Math.max(c.wheels[2].mLongitudinalSlip, c.wheels[3].mLongitudinalSlip);
    const { tc, abs } = d.id === 0 ? state : factoryAssists;
    // Live FIA GT3 TC (0-10) & ABS (0-10) intervention curves
    d.tcActive = tc > 0 && speed > 4 && input.throttle > 0.1 && slip > 0.30 - 0.022 * tc;
    d.absActive =
      abs > 0 &&
      speed > 3 &&
      input.brake > 0.2 &&
      Math.max(slip, c.wheels[0].mLongitudinalSlip, c.wheels[1].mLongitudinalSlip) > 0.34 - 0.026 * abs;

    let throttle = input.throttle * (c.shiftCut > 0 ? 0 : d.tcActive ? 0.68 - 0.02 * tc : 1);
    let brake = input.brake * (d.absActive ? 0.76 - 0.015 * abs : 1);

    // 60 km/h FIA Pit Speed Limiter (smooth fuel-cut governor + gentle overspeed brake)
    if (d.pitLimiter) {
      const over = speed - PIT_SPEED_LIMIT_MS;
      if (over > -0.45) {
        throttle = over > 0 ? 0 : throttle * clamp((-over) / 0.45, 0, 1);
      }
      if (over > 0.25) {
        brake = Math.max(brake, clamp(over * 0.45, 0.12, 0.75));
      }
    }

    // Live fuel mass effect: lighter fuel load increases responsiveness; barrier damage trims peak power/downforce
    const fuelMassRatio = BASE_CHASSIS_MASS_KG / (BASE_CHASSIS_MASS_KG + Math.max(0, d.fuelL) * FUEL_KG_PER_L);
    const damagePower = 1 - 0.18 * clamp(d.damage, 0, 1);
    d.throttle = clamp(throttle * (0.96 + 0.07 * fuelMassRatio) * damagePower, 0, 1);
    d.brake = clamp(brake, 0, 1);

    const target = clamp(input.right, -1, 1);
    c.steer += clamp(target - c.steer, -STEP * 3.8, STEP * 3.8);
    ctrl.SetDriverInput(d.throttle, -c.steer, d.brake, input.handbrake);

    // Fuel consumption proportional to throttle & RPM (~2.4 L/lap at full GT3 race pace)
    if (state.phase === 'race' && d.fuelL > 0) {
      d.fuelL = Math.max(0, d.fuelL - STEP * (0.004 + 0.026 * d.throttle * (d.rpm / 8500)));
    }

    // Pitch-sensitive GT3 ground-effect aero: nose-down braking increases front splitter downforce
    const pitchBoost = 1 + clamp(-d.pitch * 3.2, -0.08, 0.14);
    const aeroIntegrity = 1 - 0.22 * clamp(d.damage, 0, 1);
    const down = 0.5 * 1.225 * 3.65 * speed * speed * pitchBoost * aeroIntegrity;
    const drag =
      0.5 * 1.225 * (0.72 + 0.12 * d.damage) * speed * speed * (1 - input.draft * 0.23) + c.gravelShare * 1000;
    const velocity = c.body.GetLinearVelocity(),
      ratio = drag / Math.max(1, speed);
    v.Set(-velocity.GetX() * ratio, -down, -velocity.GetZ() * ratio);
    c.body.AddForce(v);
    // Front/rear aero balance shifts forward slightly under trail-braking nose pitch
    const aeroShift = 0.21 - clamp(-d.pitch * 1.1, -0.04, 0.06);
    v.Set(-Math.cos(d.yaw) * aeroShift * down, 0, Math.sin(d.yaw) * aeroShift * down);
    c.body.AddTorque(v);
  }

  function read(d: Driver) {
    const c = cars[d.id],
      p = c.body.GetPosition(),
      q = c.body.GetRotation(),
      vx = c.body.GetLinearVelocity();
    const nextSpeed = vx.Length();
    // Detect heavy wall impact deceleration spike -> progressive aero/suspension damage
    const dv = c.prevSpeed - nextSpeed;
    if (dv > 9.5 && d.brake < 0.95 && d.pitState !== 'servicing') {
      d.damage = clamp(d.damage + (dv - 9.0) * 0.022, 0, 1);
    }
    c.prevSpeed = nextSpeed;
    d.speed = nextSpeed;

    const x = q.GetX(),
      y = q.GetY(),
      z = q.GetZ(),
      w = q.GetW();
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
    let totalLoad = 0,
      gravelLoad = 0;
    const compSpec = COMPOUNDS[d.compound];
    for (let i = 0; i < 4; i++) {
      const wheel = c.wheels[i];
      d.wheelAngles[i] = wheel.GetRotationAngle();
      d.wheelCompressionM[i] = c.springLengths[i] - wheel.GetSuspensionLength();
      let tireWork = 0,
        brakingForce = 0;
      if (wheel.HasContact()) {
        const load = Math.max(0, wheel.GetSuspensionLambda());
        totalLoad += load;
        if (c.patchIsGravel[i]) gravelLoad += load;
        d.slip = Math.max(d.slip, wheel.mLongitudinalSlip);
        const relative = bodies.GetPointVelocity(c.body.GetID(), wheel.GetContactPosition());
        relative.Sub(wheel.GetContactPointVelocity());
        const along = relative.Dot(wheel.GetContactLongitudinal());
        const side = relative.Dot(wheel.GetContactLateral());
        const longImpulse = Math.abs(wheel.GetLongitudinalLambda());
        tireWork =
          longImpulse * Math.abs(c.layout[i].radius * wheel.GetAngularVelocity() - along) +
          Math.abs(wheel.GetLateralLambda() * side);
        if (d.brake > 0) brakingForce = longImpulse / STEP;
        // Progressive tread wear driven by actual dissipated contact energy & compound rate
        if (d.speed > 1.5 && d.pitState !== 'servicing') {
          const wetDryOverheat = d.compound === 'wet' && c.weather !== 'rain' && c.weather !== 'damp' ? 2.4 : 1.0;
          d.tireWear[i] = clamp(d.tireWear[i] - (tireWork * 1.15e-8) * compSpec.wearRate * wetDryOverheat, 0.05, 1);
        }
      }
      const t = d.brakeTempC[i],
        radiated = 0.25 * 5.67e-8 * ((t + 273.15) ** 4 - 300.15 ** 4);
      d.brakeTempC[i] +=
        STEP * ((brakingForce * d.speed * 0.91 - radiated) / 1850 - (t - 27) * (0.001 + 0.00025 * d.speed));
      // Wet surface accelerates cooling on wet tires; airborne preserves exact passive cooling
      const wetCool = wheel.HasContact() && (c.weather === 'rain' || c.weather === 'damp') ? 0.0045 : 0.0019;
      const heatGain = d.compound === 'wet' && (c.weather === 'clear' || c.weather === 'golden') ? tireWork / 15000 : tireWork / 24000;
      d.tireTempC[i] += heatGain - STEP * (d.tireTempC[i] - 32) * wetCool;
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
    c.prevSpeed = 0;
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
