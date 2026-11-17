import 'mapbox-gl/dist/mapbox-gl.css';
import { useEffect, useMemo, useRef } from 'react';
import Map, { Layer, Marker, Source, type MapRef } from 'react-map-gl/mapbox';
import { circlePolygon, RARITY_HEX, UCR } from '@/lib/utils';
import type { Spawn } from '@/lib/types';

type Props = {
  token: string;
  user: { lat: number; lng: number } | null;
  spawns: Spawn[];
  selectedId: string | null;
  draft?: { lat: number; lng: number } | null;
  followUser?: boolean;
  /** Pan to the selected spawn when it changes. */
  flyToSelected?: boolean;
  /** Color markers and radius rings by rarity (default). When false, everything is the plain common gray. */
  rarityColors?: boolean;
  /** Change this to fly to the selected spawn again, e.g. when it is clicked in a list while already selected. */
  focusToken?: number;
  /** Admin: spawn markers can be dragged; onMove fires when one is dropped. */
  draggableSpawns?: boolean;
  onMove?: (id: string, lat: number, lng: number) => void;
  /** Admin: draw each spawn's catch radius. */
  showCoverage?: boolean;
  /** Admin: catch density points. */
  heatmap?: { latitude: number; longitude: number; weight: number }[] | null;
  onSelect: (id: string) => void;
  onPick?: (point: { lat: number; lng: number }) => void;
  className?: string;
};

export function CampusMap({
  token,
  user,
  spawns,
  selectedId,
  draft,
  followUser,
  flyToSelected,
  rarityColors = true,
  focusToken,
  draggableSpawns,
  onMove,
  showCoverage,
  heatmap,
  onSelect,
  onPick,
  className,
}: Props) {
  const mapRef = useRef<MapRef>(null);
  const followed = useRef(false);

  useEffect(() => {
    if (!followUser || !user || followed.current || !mapRef.current) return;
    followed.current = true;
    mapRef.current.easeTo({ center: [user.lng, user.lat] });
  }, [followUser, user]);

  useEffect(() => {
    if (!flyToSelected || !selectedId) return;
    const target = spawns.find((spawn) => spawn.id === selectedId);
    const map = mapRef.current;
    if (target && map) {
      // Zoom in to a block or two, but never zoom out if the map is already closer.
      map.easeTo({ center: [target.longitude, target.latitude], zoom: Math.max(map.getZoom(), 16.5), duration: 700 });
    }
    // Only when the selection changes, not on every spawn refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyToSelected, selectedId, focusToken]);

  const coverage = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: spawns.map((spawn) => ({
        type: 'Feature' as const,
        properties: { color: rarityColors ? (RARITY_HEX[spawn.rarity] ?? RARITY_HEX.common) : RARITY_HEX.common },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [circlePolygon(spawn.latitude, spawn.longitude, spawn.radiusMeters)],
        },
      })),
    }),
    [spawns, rarityColors],
  );
  const heat = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: (heatmap ?? []).map((point) => ({
        type: 'Feature' as const,
        properties: { weight: point.weight },
        geometry: { type: 'Point' as const, coordinates: [point.longitude, point.latitude] },
      })),
    }),
    [heatmap],
  );

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
        {showCoverage ? (
          <Source id="coverage" type="geojson" data={coverage}>
            <Layer id="coverage-fill" type="fill" paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': 0.18 }} />
            <Layer id="coverage-line" type="line" paint={{ 'line-color': ['get', 'color'], 'line-width': 1.5 }} />
          </Source>
        ) : null}
        {heatmap ? (
          <Source id="heat" type="geojson" data={heat}>
            <Layer
              id="heat-layer"
              type="heatmap"
              paint={{
                'heatmap-weight': ['coalesce', ['get', 'weight'], 1],
                'heatmap-radius': 28,
                'heatmap-opacity': 0.75,
                'heatmap-color': [
                  'interpolate',
                  ['linear'],
                  ['heatmap-density'],
                  0, 'rgba(4,40,77,0)',
                  0.3, '#4aa3df',
                  0.6, '#f4c542',
                  1, '#c0392b',
                ],
              }}
            />
          </Source>
        ) : null}
        {user ? <Dot lat={user.lat} lng={user.lng} color="#f4f7fb" size={16} title="You" z={2} /> : null}
        {draft ? <Dot lat={draft.lat} lng={draft.lng} color="#ffffff" size={14} title="New spawn" /> : null}
        {spawns.map((spawn) => (
          <Dot
            key={spawn.id}
            lat={spawn.latitude}
            lng={spawn.longitude}
            title={spawn.name}
            z={selectedId === spawn.id ? 3 : 1}
            color={rarityColors ? (RARITY_HEX[spawn.rarity] ?? RARITY_HEX.common) : RARITY_HEX.common}
            faded={spawn.caught}
            selected={selectedId === spawn.id}
            size={selectedId === spawn.id ? 26 : 18}
            draggable={draggableSpawns}
            onDragEnd={(lat, lng) => onMove?.(spawn.id, lat, lng)}
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
  faded,
  selected,
  draggable,
  onDragEnd,
  onClick,
}: {
  lat: number;
  lng: number;
  color: string;
  size: number;
  title: string;
  z?: number;
  /** Already caught: drawn paler. */
  faded?: boolean;
  /** The chosen one: brighter, with a white ring and glow. */
  selected?: boolean;
  draggable?: boolean;
  onDragEnd?: (lat: number, lng: number) => void;
  onClick?: () => void;
}) {
  return (
    <Marker
      latitude={lat}
      longitude={lng}
      anchor="center"
      style={{ zIndex: z }}
      draggable={draggable}
      onDragEnd={(event) => onDragEnd?.(event.lngLat.lat, event.lngLat.lng)}
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
          border: selected ? '3px solid #ffffff' : '2px solid #04284d',
          boxShadow: selected ? `0 0 0 3px ${color}, 0 0 18px 8px ${color}` : undefined,
          filter: selected ? 'brightness(1.25) saturate(1.2)' : undefined,
          opacity: faded && !selected ? 0.5 : 1,
          transition: 'width 120ms, height 120ms, opacity 120ms',
          cursor: draggable ? 'grab' : onClick ? 'pointer' : 'default',
        }}
      />
    </Marker>
  );
}
