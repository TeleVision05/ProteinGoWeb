import 'mapbox-gl/dist/mapbox-gl.css';
import { useEffect, useRef } from 'react';
import Map, { Marker, type MapRef } from 'react-map-gl/mapbox';
import { UCR } from '@/lib/utils';
import type { Spawn } from '@/lib/types';

type Props = {
  token: string;
  user: { lat: number; lng: number } | null;
  spawns: Spawn[];
  selectedId: string | null;
  draft?: { lat: number; lng: number } | null;
  followUser?: boolean;
  onSelect: (id: string) => void;
  onPick?: (point: { lat: number; lng: number }) => void;
  className?: string;
};

export function CampusMap({ token, user, spawns, selectedId, draft, followUser, onSelect, onPick, className }: Props) {
  const mapRef = useRef<MapRef>(null);
  const followed = useRef(false);

  useEffect(() => {
    if (!followUser || !user || followed.current || !mapRef.current) return;
    followed.current = true;
    mapRef.current.easeTo({ center: [user.lng, user.lat] });
  }, [followUser, user]);

  const center = user ?? UCR;
  return (
    <div className={className}>
    <Map
      ref={mapRef}
      mapboxAccessToken={token}
      initialViewState={{ latitude: center.lat, longitude: center.lng, zoom: 16 }}
      mapStyle="mapbox://styles/mapbox/streets-v12"
      style={{ width: '100%', height: '100%' }}
      onClick={(event) => onPick?.({ lat: event.lngLat.lat, lng: event.lngLat.lng })}
    >
      {user ? <Dot lat={user.lat} lng={user.lng} color="#f4f7fb" size={16} title="You" z={2} /> : null}
      {draft ? <Dot lat={draft.lat} lng={draft.lng} color="#ffffff" size={14} title="New spawn" /> : null}
      {spawns.map((spawn) => (
        <Dot
          key={spawn.id}
          lat={spawn.latitude}
          lng={spawn.longitude}
          title={spawn.name}
          z={selectedId === spawn.id ? 3 : 1}
          color={spawn.caught ? '#1f7a4d' : '#e0a100'}
          size={selectedId === spawn.id ? 24 : 18}
          onClick={() => onSelect(spawn.id)}
        />
      ))}
    </Map>
    </div>
  );
}

function Dot({
  lat,
  lng,
  color,
  size,
  title,
  z,
  onClick,
}: {
  lat: number;
  lng: number;
  color: string;
  size: number;
  title: string;
  z?: number;
  onClick?: () => void;
}) {
  return (
    <Marker
      latitude={lat}
      longitude={lng}
      anchor="center"
      style={{ zIndex: z }}
      onClick={(event) => {
        event.originalEvent.stopPropagation();
        onClick?.();
      }}
    >
      <div
        title={title}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          background: color,
          border: '2px solid #04284d',
          cursor: onClick ? 'pointer' : 'default',
        }}
      />
    </Marker>
  );
}
