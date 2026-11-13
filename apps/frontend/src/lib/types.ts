export type Me = {
  user: { id: string; name: string; email: string; image: string | null };
  isAdmin: boolean;
  access: { active: boolean; expiresAt: string | null; label: string | null };
  /** Test switch: catching needs no location. */
  catchAnywhere?: boolean;
};

export type Spawn = {
  id: string;
  name: string;
  summary: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  expiresAt: string | null;
  createdAt: string;
  hasModel: boolean;
  modelUrl: string | null;
  modelFilename: string | null;
  caught: boolean;
};

export type AccessCode = {
  id: string;
  code: string;
  label: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  redemptions: number;
  status: 'active' | 'expired' | 'revoked';
};
