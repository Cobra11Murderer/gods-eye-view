import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { AQI_CITIES } from './airQuality.js';

/**
 * Live UV Index at the same curated city list Air Quality uses — one fewer
 * hardcoded list to keep in sync, and the two overview layers read the same
 * set of places.
 */
const API_URL = '/api/uv-index';
const REFRESH_INTERVAL_MS = 900_000;

const UV_LEVELS = [
  { max: 2, color: Cesium.Color.fromCssColorString('#00e400'), label: 'LOW' },
  { max: 5, color: Cesium.Color.fromCssColorString('#ffff00'), label: 'MODERATE' },
  { max: 7, color: Cesium.Color.fromCssColorString('#ff7e00'), label: 'HIGH' },
  { max: 10, color: Cesium.Color.fromCssColorString('#ff0000'), label: 'VERY HIGH' },
  { max: Infinity, color: Cesium.Color.fromCssColorString('#8f3f97'), label: 'EXTREME' },
];

export function uvLevel(uv) {
  return UV_LEVELS.find((level) => uv <= level.max) || UV_LEVELS[UV_LEVELS.length - 1];
}

function buildQueryString() {
  const lats = AQI_CITIES.map((c) => c.lat).join(',');
  const lons = AQI_CITIES.map((c) => c.lon).join(',');
  return `latitude=${lats}&longitude=${lons}&current=uv_index`;
}

const QUERY_STRING = buildQueryString();

export function createUvIndexLayer() {
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _error = null;

  async function refresh() {
    try {
      const response = await fetch(`${API_URL}?${QUERY_STRING}`, { cache: 'no-store' });
      if (!response.ok) {
        _error = `Open-Meteo HTTP ${response.status}`;
        return false;
      }
      const results = await response.json();
      if (!Array.isArray(results) || results.length !== AQI_CITIES.length) {
        _error = 'Malformed Open-Meteo response';
        return false;
      }

      const nextEntities = [];
      let count = 0;
      for (let i = 0; i < AQI_CITIES.length; i++) {
        const city = AQI_CITIES[i];
        const uv = results[i]?.current?.uv_index;
        if (!Number.isFinite(uv)) continue;
        const level = uvLevel(uv);
        // Only surface cities with meaningful daytime UV — plotting every
        // city at "0 · LOW" through the night side is just clutter.
        if (uv <= 0) continue;
        const radius = 30000 + Math.min(uv, 12) * 6000;
        count++;
        nextEntities.push(new Cesium.Entity({
          id: `uv:${city.name}`,
          position: Cesium.Cartesian3.fromDegrees(city.lon, city.lat),
          ellipse: {
            semiMajorAxis: radius,
            semiMinorAxis: radius,
            material: new Cesium.ColorMaterialProperty(level.color.withAlpha(0.3)),
            outline: true,
            outlineColor: level.color.withAlpha(0.9),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
          label: {
            text: `${city.name} · UV ${uv.toFixed(1)}`,
            font: '13px sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -8),
            scaleByDistance: new Cesium.NearFarScalar(1.0e6, 1.0, 1.2e7, 0.4),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: { uv, level: level.label },
        }));
      }

      _dataSource.entities.removeAll();
      for (const entity of nextEntities) _dataSource.entities.add(entity);
      _count = count;
      _lastUpdate = Date.now();
      _error = null;
      governorRequestRender('uv-index-refresh');
      console.log(`[Data:UvIndex] Updated: ${_count} cities with daytime UV`);
      return true;
    } catch (err) {
      console.warn('[Data:UvIndex] Fetch error:', err);
      _error = 'Open-Meteo network error';
      return false;
    }
  }

  return {
    id: 'uv-index',
    name: 'UV Index',
    icon: '☀️',
    source: 'Open-Meteo',
    updateInterval: REFRESH_INTERVAL_MS,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('uv-index');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _enabled = false;
      _lastUpdate = null;
      _error = null;
      console.log('[Data:UvIndex] Initialized');
    },

    async enable(viewer) {
      _enabled = true;
      _viewer = viewer;
      if (_dataSource) _dataSource.show = true;
      governorRequestRender('uv-index-enable');
      if (!_lastUpdate) await refresh();
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      governorRequestRender('uv-index-disable');
    },

    async update() {
      if (!_enabled) return false;
      return refresh();
    },

    destroy(viewer) {
      _enabled = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _error = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _error };
    },
  };
}

const uvIndexLayer = createUvIndexLayer();

export default uvIndexLayer;
