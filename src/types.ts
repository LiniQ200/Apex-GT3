import type { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';

export type Weather = 'golden' | 'damp';
export type CameraMode = 'chase' | 'cockpit' | 'hood' | 'tv';
export type Phase = 'garage' | 'lights' | 'race' | 'paused' | 'finished';
export type SurfaceId = 'asphalt' | 'groove' | 'kerb' | 'grass' | 'gravel';
export interface Settings { chassis: '458' | 'concept'; livery: number; weather: Weather; mode: 'sprint' | 'hotlap'; pace: 'clubman' | 'pro' | 'platinum'; transmission: 'auto' | 'manual'; graphics: 'balanced' | 'high' | 'ultra' }
export const defaults: Settings = { chassis: '458', livery: 0, weather: 'golden', mode: 'sprint', pace: 'pro', transmission: 'auto', graphics: 'high' };
export const teams = [
  ['88','Scuderia Rosso Corsa','#d21d2e','#fff0d3'], ['92','Weissach','#acb3b6','#d3ef35'],
  ['44','Eifelring','#086856','#edbd70'], ['19','Heritage Racing','#397eaf','#ff7c35'], ['07','Apex Stealth','#25282c','#e62d48'],
] as const;
export interface TrackPoint { s:number; x:number; y:number; z:number; yaw:number; slope:number; bank:number; kappa:number; halfWidth:number }
// Y-up, +Z forward. Positive d is right, yaw=atan2(dx,dz), positive bank raises the right edge.
export interface Circuit { length:number; samples:TrackPoint[]; at(s:number,d?:number):TrackPoint; nearest(x:number,z:number):{s:number;d:number;surface:SurfaceId} }
export interface CollisionMesh { positions:number[]; indices:number[]; kind:'road'|'kerb'|'runoff'|'wall' }
export interface TrackScene { colliders: CollisionMesh[]; setWeather(w:Weather):void; setLights(n:number):void }
// Resting hub centres and tread radii in metres in the rig frame (road origin, +Z forward).
interface WheelGeometry { readonly x: number; readonly y: number; readonly z: number; readonly radius: number }
export type WheelLayout = readonly [WheelGeometry, WheelGeometry, WheelGeometry, WheelGeometry]; // FL, FR, RL, RR
export type GridWheelLayouts = (driverId: number) => WheelLayout;
// wheelAngles: FL, FR, RL, RR spin in radians; wheelAngle is the legacy FL reading.
export interface Driver { id:number; name:string; number:string; livery:number; x:number; y:number; z:number; yaw:number; pitch:number; roll:number; s:number; d:number; distance:number; distanceAtFlag?:number; completedLaps:number; finishTime:number|null; speed:number; rpm:number; gear:number; throttle:number; brake:number; steer:number; slip:number; wheelAngle:number; wheelAngles:[number,number,number,number]; wheelCompressionM:number[]; tireTempC:number[]; brakeTempC:number[]; tcActive:boolean; absActive:boolean; surface:SurfaceId }
// Car pose origin on the road under its centre. Speed in m/s; steer/angles in radians. ID 0 is the player.
export interface RaceState { phase:Phase; settings:Settings; drivers:Driver[]; camera:CameraMode; elapsed:number; lap:number; lapTime:number; bestLap:number; sectors:number[]; lastSectors:number[]; delta:number; lights:number; tc:number; abs:number; muted:boolean; autopilot:boolean; fps:number; backend:string; peakSpeedKmh:number; maxGearReached:number; maxBrakeTempC:number; nanDetected:boolean }
export interface VehicleRig { root:TransformNode; update(driver:Driver,dt:number,driverView?:boolean):void; dispose():void }
export type BuildVehicle = (scene:Scene,chassis:Settings['chassis'],livery:number,number:string)=>Promise<VehicleRig>;
export interface UiActions { configure(patch:Partial<Settings>):void; start():void; resume():void; garage():void; restart():void; cycleTc():void; cycleAbs():void; toggleMute():void }
export interface AudioRig { unlock():void; update(state:RaceState):void; dispose():void }
