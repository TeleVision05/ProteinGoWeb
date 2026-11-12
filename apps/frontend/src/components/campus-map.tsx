import { APIProvider, Map, Marker, useApiIsLoaded, useMap } from '@vis.gl/react-google-maps';
import { useEffect, useRef } from 'react';
import { UCR } from '@/lib/utils';
import type { Spawn } from '@/lib/types';

const MAP_STYLES: google.maps.MapTypeStyle[] = [
  { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.attraction', stylers: [{ visibility: 'off' }] },
];

type Props = {
  apiKey: string;
  user: { lat: number; lng: number } | null;
  spawns: Spawn[];
  selectedId: string | null;
  draft?: { lat: number; lng: number } | null;
  followUser?: boolean;
  onSelect: (id: string) => void;
  onPick?: (point: { lat: number; lng: number }) => void;
  className?: string;
};

export function CampusMap(props: Props) {
  return (
    <APIProvider apiKey={props.apiKey}>
      <MapCanvas {...props} />
    </APIProvider>
  );
}

function MapCanvas({ user, spawns, selectedId, draft, followUser, onSelect, onPick, className }: Props) {
  return (
    <Map
      defaultCenter={user ?? UCR}
      defaultZoom={16}
      gestureHandling="greedy"
      clickableIcons={false}
      styles={MAP_STYLES}
      className={className}
      onClick={(event) => {
        if (!onPick || !event.detail.latLng) return;
        onPick({ lat: event.detail.latLng.lat, lng: event.detail.latLng.lng });
      }}
    >
      <FollowUser user={followUser ? user : null} />
      <Dots user={user} spawns={spawns} selectedId={selectedId} draft={draft ?? null} onSelect={onSelect} />
    </Map>
  );
}

function FollowUser({ user }: { user: { lat: number; lng: number } | null }) {
  const map = useMap();
  const followed = useRef(false);
  useEffect(() => {
    if (!map || !user || followed.current) return;
    followed.current = true;
    map.panTo(user);
  }, [map, user]);
  return null;
}

function Dots({
  user,
  spawns,
  selectedId,
  draft,
  onSelect,
}: {
  user: { lat: number; lng: number } | null;
  spawns: Spawn[];
  selectedId: string | null;
  draft: { lat: number; lng: number } | null;
  onSelect: (id: string) => void;
}) {
  const ready = useApiIsLoaded();
  if (!ready) return null;
  const circle = (color: string, scale: number): google.maps.Symbol => ({
    path: google.maps.SymbolPath.CIRCLE,
    scale,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: '#04284d',
    strokeWeight: 2,
  });
  return (
    <>
      {user ? <Marker position={user} title="You" icon={circle('#f4f7fb', 8)} zIndex={2} /> : null}
      {draft ? <Marker position={draft} title="New spawn" icon={circle('#ffffff', 7)} /> : null}
      {spawns.map((spawn) => (
        <Marker
          key={spawn.id}
          position={{ lat: spawn.latitude, lng: spawn.longitude }}
          title={spawn.name}
          zIndex={selectedId === spawn.id ? 3 : 1}
          icon={circle(spawn.caught ? '#1f7a4d' : '#e0a100', selectedId === spawn.id ? 12 : 9)}
          onClick={() => onSelect(spawn.id)}
        />
      ))}
    </>
  );
}
