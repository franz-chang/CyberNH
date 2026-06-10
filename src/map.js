const { GRID_COLS, GRID_ROWS, TILE_SIZE_M } = require("./config");

const PASSABLE = new Set(["corridor", "room", "nurse", "activity", "dining", "balcony", "storage"]);

function createMapState() {
  const grid = Array.from({ length: GRID_ROWS }, () => Array.from({ length: GRID_COLS }, () => "wall"));
  const roomTargets = [];
  const areaLabels = [];

  fillRect(grid, 4, 0, 30, 23, "courtyard");
  fillRect(grid, 0, 20, 34, 24, "courtyard");

  // Original CyberNH_GUI U-shaped corridors: two 2-cell wide wings and a shared base.
  fillRect(grid, 9, 3, 10, 22, "corridor");
  fillRect(grid, 24, 3, 25, 22, "corridor");
  fillRect(grid, 9, 22, 25, 22, "corridor");

  // Original public areas at the two wing ends.
  fillRect(grid, 4, 0, 8, 2, "activity");
  fillRect(grid, 11, 0, 15, 2, "dining");
  fillRect(grid, 9, 0, 10, 2, "balcony");
  addAreaLabel(areaLabels, "activity-a", "活动A", 6, 1);
  addAreaLabel(areaLabels, "dining-a", "餐饮A", 13, 1);
  addAreaLabel(areaLabels, "balcony-a", "阳台A", 9, 1);

  fillRect(grid, 18, 0, 22, 2, "activity");
  fillRect(grid, 26, 0, 30, 2, "dining");
  fillRect(grid, 23, 0, 25, 2, "balcony");
  addAreaLabel(areaLabels, "activity-b", "活动B", 20, 1);
  addAreaLabel(areaLabels, "dining-b", "餐饮B", 28, 1);
  addAreaLabel(areaLabels, "balcony-b", "阳台B", 24, 1);

  fillRect(grid, 12, 23, 15, 24, "activity");
  fillRect(grid, 19, 23, 22, 24, "storage");
  fillRect(grid, 16, 22, 18, 23, "nurse");
  addAreaLabel(areaLabels, "nurse", "护理站", 17, 22);
  addAreaLabel(areaLabels, "shared", "共享区", 13, 23);
  addAreaLabel(areaLabels, "storage", "设备库", 20, 23);

  const addRoom = (room, wing, x1, y1, x2, y2, doorX, doorY) => {
    fillRect(grid, x1, y1, x2, y2, "room");
    const center = { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
    roomTargets.push({
      room,
      wing,
      tile: center,
      targetTile: { x: doorX, y: doorY },
      label: room,
    });
  };

  const roomRows = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21];
  roomRows.forEach((row, index) => {
    addRoom(`A-${String(index + 1).padStart(2, "0")}`, "A", 4, row, 8, row, 8, row);
    addRoom(`A-${String(index + 11).padStart(2, "0")}`, "A", 11, row, 15, row, 11, row);
    addRoom(`B-${String(index + 1).padStart(2, "0")}`, "B", 18, row, 23, row, 23, row);
    addRoom(`B-${String(index + 11).padStart(2, "0")}`, "B", 26, row, 30, row, 26, row);
  });

  // Keep room doors open after room rectangles are painted.
  fillRect(grid, 9, 3, 10, 22, "corridor");
  fillRect(grid, 24, 3, 25, 22, "corridor");
  fillRect(grid, 9, 22, 25, 22, "corridor");
  fillRect(grid, 16, 22, 18, 23, "nurse");

  return {
    cols: GRID_COLS,
    rows: GRID_ROWS,
    tileSizeM: TILE_SIZE_M,
    allowDiagonal: false,
    grid,
    roomTargets,
    areaLabels,
  };
}

function fillRect(grid, x1, y1, x2, y2, type) {
  for (let y = y1; y <= y2; y += 1) {
    for (let x = x1; x <= x2; x += 1) {
      if (x >= 0 && y >= 0 && x < GRID_COLS && y < GRID_ROWS) grid[y][x] = type;
    }
  }
}

function addAreaLabel(areaLabels, id, label, x, y) {
  areaLabels.push({ id, label, tile: { x, y } });
}

function isPassable(map, tile) {
  if (!tile || tile.x < 0 || tile.y < 0 || tile.x >= map.cols || tile.y >= map.rows) return false;
  return PASSABLE.has(map.grid[tile.y][tile.x]);
}

function sameCell(a, b) {
  return a && b && a.x === b.x && a.y === b.y;
}

function computeRoute(map, start, target) {
  if (sameCell(start, target)) {
    return { path: [{ ...start }], distanceM: 0, reachable: true };
  }
  if (!isPassable(map, start) || !isPassable(map, target)) {
    return { path: [], distanceM: Infinity, reachable: false };
  }

  const queue = [{ ...start }];
  const cameFrom = new Map();
  const key = (tile) => `${tile.x},${tile.y}`;
  cameFrom.set(key(start), null);
  const dirs = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];

  while (queue.length) {
    const current = queue.shift();
    if (sameCell(current, target)) break;
    for (const dir of dirs) {
      const next = { x: current.x + dir.x, y: current.y + dir.y };
      const nextKey = key(next);
      if (!cameFrom.has(nextKey) && isPassable(map, next)) {
        cameFrom.set(nextKey, current);
        queue.push(next);
      }
    }
  }

  const targetKey = key(target);
  if (!cameFrom.has(targetKey)) {
    return { path: [], distanceM: Infinity, reachable: false };
  }

  const path = [];
  let current = { ...target };
  while (current) {
    path.push({ ...current });
    current = cameFrom.get(key(current));
  }
  path.reverse();
  return {
    path,
    distanceM: Math.max(0, path.length - 1) * TILE_SIZE_M,
    reachable: true,
  };
}

function roomLookup(map) {
  return Object.fromEntries(map.roomTargets.map((room) => [room.room, room]));
}

module.exports = { createMapState, computeRoute, roomLookup, sameCell, isPassable };
