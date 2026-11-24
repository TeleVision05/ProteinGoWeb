import { UCR } from '@/lib/utils';

/** What GET /api/explored sends: the grid (25 m squares counted from a point on campus) and the squares already walked. */
export type ExploredInfo = {
  originLat: number;
  originLng: number;
  cellMeters: number;
  maxCell: number;
  cells: [number, number][];
};

const M_PER_DEG_LAT = 110_574;

/**
 * The map squares the player has walked through, so the fog stays cleared there. The grid matches the server's
 * (a fixed point on campus, 25 m squares). Squares are added as the player walks; the fog layer reads them
 * through `takeFresh` and `version` so it can draw each one once.
 */
export class ExploredStore {
  cellMeters = 25;
  maxCell = 120;
  private originLat = UCR.lat;
  private originLng = UCR.lng;
  private readonly seen = new Set<string>();
  private fresh: [number, number][] = [];
  /** Goes up whenever squares were added, so a reader knows to look again. */
  version = 0;
  /** Goes up when the whole set was replaced (loaded from the server), so a reader redraws everything. */
  resets = 0;

  load(info: ExploredInfo) {
    this.cellMeters = info.cellMeters;
    this.maxCell = info.maxCell;
    this.originLat = info.originLat;
    this.originLng = info.originLng;
    for (const [cx, cy] of info.cells) {
      const key = `${cx},${cy}`;
      if (!this.seen.has(key)) this.seen.add(key);
    }
    this.fresh = [];
    this.resets++;
    this.version++;
  }

  /** The square a position is in, or null when it is off the grid. */
  cellOf(lat: number, lng: number) {
    const east = (lng - this.originLng) * 111_320 * Math.cos((this.originLat * Math.PI) / 180);
    const north = (lat - this.originLat) * M_PER_DEG_LAT;
    const cx = Math.floor(east / this.cellMeters);
    const cy = Math.floor(north / this.cellMeters);
    return Math.abs(cx) > this.maxCell || Math.abs(cy) > this.maxCell ? null : { cx, cy };
  }

  /** Marks a square explored. Returns true when it was new. */
  add(cx: number, cy: number) {
    const key = `${cx},${cy}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.fresh.push([cx, cy]);
    this.version++;
    return true;
  }

  /** Every square, for a full redraw. */
  all(): [number, number][] {
    return [...this.seen].map((key) => key.split(',').map(Number) as [number, number]);
  }

  /** The squares added since the last call (not including a fresh load). */
  takeFresh() {
    const out = this.fresh;
    this.fresh = [];
    return out;
  }
}
