import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const UCR = { lat: 33.9737, lng: -117.3281 };

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const earth = 6_371_000;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Initial compass bearing from point 1 to point 2, degrees clockwise from north. */
export function bearingDegrees(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compassLabel = (deg: number) => COMPASS[Math.round(deg / 45) % 8];

export const RARITY_LABEL: Record<string, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  legendary: 'Legendary',
};
export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'legendary'] as const;
/** Marker colors on the map, one per rarity. */
export const RARITY_HEX: Record<string, string> = {
  common: '#7a8699',
  uncommon: '#1f9d63',
  rare: '#2f7fd8',
  legendary: '#e0a100',
};
export const RARITY_COLOR: Record<string, string> = {
  common: 'bg-secondary text-secondary-foreground',
  uncommon: 'bg-emerald-700 text-white',
  rare: 'bg-sky-700 text-white',
  legendary: 'bg-gold text-campus',
};

/** A polygon approximating a circle of `radius` meters (for coverage rings on the map). */
export function circlePolygon(lat: number, lng: number, radius: number, steps = 40) {
  const ring: [number, number][] = [];
  const dLat = radius / 111_320;
  const dLng = radius / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return ring;
}
