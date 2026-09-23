export interface SpawnLocation {
  lat: number;
  lon: number;
  name: string;
  /** If set, load the prebuilt recipe at public/recipes/<baked>.json instead of compiling live. */
  baked?: string;
  /** Game mode chosen in the spawn picker (main.ts sets g.mode). Default 'takedown'. */
  mode?: 'takedown' | 'freeroam';
}
export type Progress = (stage: string, fraction: number) => void;
