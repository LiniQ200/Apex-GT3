import type { GridWheelLayouts, RaceState, Settings, Weather } from '../types';
import type { makeRoad } from '../track/road';
import type { TrackSurfaceGrid } from '../track/surfaceState';

export interface DrivingView {
  canvas: HTMLCanvasElement;
  backend: string;
  adapter: string;
  software: boolean;
  reason: string;
  prepareTrack(road: ReturnType<typeof makeRoad>, weather: Weather, surfaceGrid?: TrackSurfaceGrid): Promise<void>;
  wheelLayouts(settings: Pick<Settings, 'chassis' | 'mode'>): Promise<GridWheelLayouts>;
  present(state: RaceState): Promise<void>;
  setWeather(weather: Weather): Promise<void>;
  confirmPicture(): Promise<void>;
  quality(profile: Settings['graphics']): void;
  ready(): boolean;
  onGraphicsReset(lost: () => void, restored: () => void): void;
  run(frame: (dt: number, fps: number) => void, failed: (error: unknown) => void): void;
  draw(state: RaceState, lookBack: boolean, dt: number): void;
  resize(): void;
  dispose(): void;
}

export class GraphicsUnavailable extends Error {}
