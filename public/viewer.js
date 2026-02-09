const BASE_CELL_SIZE = 24;
const GRID_LINE_COLOR = "#e7edf5";
const MINIMAP_PADDING = 8;
const EVENT_PAGE_LIMIT = 1000;
const CAMERA_STORAGE_KEY = "clawglyph.viewer.camera.v1";
const CAMERA_SAVE_DEBOUNCE_MS = 120;

const boardCanvas = document.getElementById("board");
const minimapCanvas = document.getElementById("minimap");
const boardWrap = document.getElementById("board-wrap");
const metaNode = document.getElementById("meta");

if (!(boardCanvas instanceof HTMLCanvasElement)) {
  throw new Error("board canvas element not found");
}
if (!(minimapCanvas instanceof HTMLCanvasElement)) {
  throw new Error("minimap canvas element not found");
}
if (!(boardWrap instanceof HTMLElement)) {
  throw new Error("board wrapper not found");
}
if (!(metaNode instanceof HTMLElement)) {
  throw new Error("meta element not found");
}

const boardCtx = boardCanvas.getContext("2d");
const minimapCtx = minimapCanvas.getContext("2d");

if (!boardCtx || !minimapCtx) {
  throw new Error("2d context not available");
}

const camera = {
  x: 0,
  y: 0,
  zoom: 1,
  fitZoom: 1,
  minZoom: 0.1,
  maxZoom: 80
};

const viewport = {
  width: 1,
  height: 1
};

const world = {
  width: 1,
  height: 1
};

const minimapLayout = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  width: 0,
  height: 0
};

let board = null;
let boardSizeKey = "";
let hasUserNavigated = false;
const boardPointers = new Map();
let boardGestureState = null;
let boardTouchGestureState = null;
let minimapDraggingPointerId = null;
let cellMap = new Map();
let lastSeenEventId = 0;
let eventStream = null;
let catchupInFlight = false;
let initialCameraState = readCameraState();
let cameraSaveTimer = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function parseEventId(raw) {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
    return -1;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function coordinateKey(x, y) {
  return `${x}:${y}`;
}

function normalizeBoardCells(cells) {
  const nextMap = new Map();

  for (const rawCell of cells) {
    if (!rawCell || typeof rawCell !== "object") {
      continue;
    }

    const x = rawCell.x;
    const y = rawCell.y;
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      continue;
    }

    const cell = {
      x,
      y,
      glyph: typeof rawCell.glyph === "string" ? rawCell.glyph : String(rawCell.glyph ?? ""),
      color: typeof rawCell.color === "string" ? rawCell.color : "#111111",
      agentId: typeof rawCell.agentId === "string" ? rawCell.agentId : "unknown",
      updatedAt: typeof rawCell.updatedAt === "string" ? rawCell.updatedAt : new Date().toISOString(),
      eventId: typeof rawCell.eventId === "string" ? rawCell.eventId : String(rawCell.eventId ?? "0")
    };

    const key = coordinateKey(cell.x, cell.y);
    const previous = nextMap.get(key);
    if (!previous) {
      nextMap.set(key, cell);
      continue;
    }

    const previousEventId = parseEventId(previous.eventId);
    const nextEventId = parseEventId(cell.eventId);
    if (nextEventId >= previousEventId) {
      nextMap.set(key, cell);
    }
  }

  return nextMap;
}

function getMaxEventId(cells) {
  let maxId = 0;
  for (const cell of cells) {
    const parsed = parseEventId(cell.eventId);
    if (parsed > maxId) {
      maxId = parsed;
    }
  }
  return maxId;
}

function parseJsonSafe(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function readCameraState() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const storage = window.localStorage;
    const raw = storage.getItem(CAMERA_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    const x = Number(parsed?.x);
    const y = Number(parsed?.y);
    const zoom = Number(parsed?.zoom);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom) || zoom <= 0) {
      return null;
    }

    return { x, y, zoom };
  } catch {
    return null;
  }
}

function writeCameraState() {
  if (!board || typeof window === "undefined") {
    return;
  }

  try {
    const storage = window.localStorage;
    storage.setItem(
      CAMERA_STORAGE_KEY,
      JSON.stringify({
        x: camera.x,
        y: camera.y,
        zoom: camera.zoom
      })
    );
  } catch {
    // no-op
  }
}

function clearCameraSaveTimer() {
  if (cameraSaveTimer !== null) {
    window.clearTimeout(cameraSaveTimer);
    cameraSaveTimer = null;
  }
}

function scheduleCameraStateSave() {
  if (!board || cameraSaveTimer !== null) {
    return;
  }

  cameraSaveTimer = window.setTimeout(() => {
    cameraSaveTimer = null;
    writeCameraState();
  }, CAMERA_SAVE_DEBOUNCE_MS);
}

function restoreCameraStateIfNeeded() {
  if (!initialCameraState) {
    return false;
  }

  camera.x = initialCameraState.x;
  camera.y = initialCameraState.y;
  camera.zoom = initialCameraState.zoom;
  hasUserNavigated = true;
  initialCameraState = null;
  return true;
}

async function resolveLatestEventId(snapshot) {
  const totalFromSnapshot = Number.isSafeInteger(snapshot.totalEvents) && snapshot.totalEvents >= 0
    ? snapshot.totalEvents
    : 0;
  let latest = Math.max(lastSeenEventId, getMaxEventId(snapshot.cells), totalFromSnapshot);

  try {
    const response = await fetch("/v1/meta", { cache: "no-store" });
    if (!response.ok) {
      return latest;
    }
    const json = await response.json();
    const metaLatestId = parseEventId(json?.data?.events?.latestEventId ?? null);
    if (metaLatestId >= 0) {
      latest = Math.max(latest, metaLatestId);
    }
  } catch {
    // no-op
  }

  return latest;
}

function refreshCanvasSize() {
  const width = Math.max(220, Math.floor(boardWrap.clientWidth));
  const height = Math.max(220, Math.floor(boardWrap.clientHeight));

  if (boardCanvas.width !== width || boardCanvas.height !== height) {
    boardCanvas.width = width;
    boardCanvas.height = height;
  }

  const minimapWidth = Math.max(120, Math.floor(minimapCanvas.clientWidth));
  const minimapHeight = Math.max(120, Math.floor(minimapCanvas.clientHeight));

  if (minimapCanvas.width !== minimapWidth || minimapCanvas.height !== minimapHeight) {
    minimapCanvas.width = minimapWidth;
    minimapCanvas.height = minimapHeight;
  }

  viewport.width = width;
  viewport.height = height;
}

function updateZoomBounds() {
  const fitZoom = Math.min(viewport.width / world.width, viewport.height / world.height);
  camera.fitZoom = Number.isFinite(fitZoom) && fitZoom > 0 ? fitZoom : 1;
  camera.minZoom = Math.min(camera.fitZoom, Math.max(camera.fitZoom * 0.2, 0.001));
  camera.maxZoom = Math.max(camera.fitZoom * 120, 60);
  camera.zoom = clamp(camera.zoom, camera.minZoom, camera.maxZoom);
}

function clampCamera() {
  const visibleWidth = viewport.width / camera.zoom;
  const visibleHeight = viewport.height / camera.zoom;

  if (world.width <= visibleWidth) {
    camera.x = (world.width - visibleWidth) / 2;
  } else {
    camera.x = clamp(camera.x, 0, world.width - visibleWidth);
  }

  if (world.height <= visibleHeight) {
    camera.y = (world.height - visibleHeight) / 2;
  } else {
    camera.y = clamp(camera.y, 0, world.height - visibleHeight);
  }
}

function fitBoardToViewport() {
  updateZoomBounds();
  camera.zoom = camera.fitZoom;
  camera.x = (world.width - viewport.width / camera.zoom) / 2;
  camera.y = (world.height - viewport.height / camera.zoom) / 2;
  clampCamera();
}

function applyBoardData(nextBoard, resetView) {
  board = nextBoard;
  world.width = Math.max(1, board.width * BASE_CELL_SIZE);
  world.height = Math.max(1, board.height * BASE_CELL_SIZE);
  refreshCanvasSize();
  updateZoomBounds();

  if (resetView || !hasUserNavigated) {
    fitBoardToViewport();
    hasUserNavigated = false;
  } else {
    clampCamera();
  }
}

function drawMainBoard() {
  if (!board) {
    return;
  }

  boardCtx.setTransform(1, 0, 0, 1, 0, 0);
  boardCtx.clearRect(0, 0, boardCanvas.width, boardCanvas.height);
  boardCtx.fillStyle = "#f8fbff";
  boardCtx.fillRect(0, 0, boardCanvas.width, boardCanvas.height);

  boardCtx.setTransform(
    camera.zoom,
    0,
    0,
    camera.zoom,
    -camera.x * camera.zoom,
    -camera.y * camera.zoom
  );

  boardCtx.fillStyle = "#ffffff";
  boardCtx.fillRect(0, 0, world.width, world.height);

  const cellScreenSize = BASE_CELL_SIZE * camera.zoom;
  if (cellScreenSize >= 3) {
    boardCtx.strokeStyle = GRID_LINE_COLOR;
    boardCtx.lineWidth = 1 / camera.zoom;
    for (let x = 0; x <= board.width; x += 1) {
      const px = x * BASE_CELL_SIZE + 0.5 / camera.zoom;
      boardCtx.beginPath();
      boardCtx.moveTo(px, 0);
      boardCtx.lineTo(px, world.height);
      boardCtx.stroke();
    }
    for (let y = 0; y <= board.height; y += 1) {
      const py = y * BASE_CELL_SIZE + 0.5 / camera.zoom;
      boardCtx.beginPath();
      boardCtx.moveTo(0, py);
      boardCtx.lineTo(world.width, py);
      boardCtx.stroke();
    }
  }

  boardCtx.textAlign = "center";
  boardCtx.textBaseline = "middle";
  boardCtx.font = `${Math.floor(BASE_CELL_SIZE * 0.72)}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;

  for (const cell of board.cells) {
    boardCtx.fillStyle = cell.color;
    const centerX = cell.x * BASE_CELL_SIZE + BASE_CELL_SIZE / 2;
    const centerY = cell.y * BASE_CELL_SIZE + BASE_CELL_SIZE / 2;
    boardCtx.fillText(cell.glyph, centerX, centerY);
  }

  boardCtx.strokeStyle = "#b7c6d6";
  boardCtx.lineWidth = 2 / camera.zoom;
  boardCtx.strokeRect(0, 0, world.width, world.height);

  boardCtx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawMiniMap() {
  if (!board) {
    return;
  }

  minimapCtx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
  minimapCtx.fillStyle = "#f8fbff";
  minimapCtx.fillRect(0, 0, minimapCanvas.width, minimapCanvas.height);

  const availableWidth = Math.max(1, minimapCanvas.width - MINIMAP_PADDING * 2);
  const availableHeight = Math.max(1, minimapCanvas.height - MINIMAP_PADDING * 2);
  const mapScale = Math.min(availableWidth / world.width, availableHeight / world.height);

  minimapLayout.scale = mapScale;
  minimapLayout.width = world.width * mapScale;
  minimapLayout.height = world.height * mapScale;
  minimapLayout.offsetX = (minimapCanvas.width - minimapLayout.width) / 2;
  minimapLayout.offsetY = (minimapCanvas.height - minimapLayout.height) / 2;

  minimapCtx.fillStyle = "#ffffff";
  minimapCtx.fillRect(
    minimapLayout.offsetX,
    minimapLayout.offsetY,
    minimapLayout.width,
    minimapLayout.height
  );

  const miniCellSize = BASE_CELL_SIZE * mapScale;
  const dotSize = Math.max(1, miniCellSize);

  for (const cell of board.cells) {
    const x = minimapLayout.offsetX + cell.x * BASE_CELL_SIZE * mapScale;
    const y = minimapLayout.offsetY + cell.y * BASE_CELL_SIZE * mapScale;
    minimapCtx.fillStyle = cell.color;
    minimapCtx.fillRect(x, y, dotSize, dotSize);
  }

  minimapCtx.strokeStyle = "#9eb5cb";
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(
    minimapLayout.offsetX,
    minimapLayout.offsetY,
    minimapLayout.width,
    minimapLayout.height
  );

  const visibleWorldWidth = viewport.width / camera.zoom;
  const visibleWorldHeight = viewport.height / camera.zoom;

  const viewX = minimapLayout.offsetX + camera.x * mapScale;
  const viewY = minimapLayout.offsetY + camera.y * mapScale;
  const viewWidth = visibleWorldWidth * mapScale;
  const viewHeight = visibleWorldHeight * mapScale;

  minimapCtx.fillStyle = "rgba(11, 123, 203, 0.15)";
  minimapCtx.fillRect(viewX, viewY, viewWidth, viewHeight);
  minimapCtx.strokeStyle = "#0b7bcb";
  minimapCtx.lineWidth = 1.2;
  minimapCtx.strokeRect(viewX, viewY, viewWidth, viewHeight);
}

function render() {
  if (!board) {
    return;
  }
  drawMainBoard();
  drawMiniMap();
  metaNode.textContent = `Board: ${board.width} x ${board.height} / Events: ${board.totalEvents} / Zoom: ${(camera.zoom * 100).toFixed(1)}%`;
}

function moveCameraToWorldCenter(worldX, worldY) {
  const visibleWorldWidth = viewport.width / camera.zoom;
  const visibleWorldHeight = viewport.height / camera.zoom;
  camera.x = worldX - visibleWorldWidth / 2;
  camera.y = worldY - visibleWorldHeight / 2;
  clampCamera();
}

function minimapEventToWorld(event) {
  const rect = minimapCanvas.getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;

  const withinX =
    px >= minimapLayout.offsetX && px <= minimapLayout.offsetX + minimapLayout.width;
  const withinY =
    py >= minimapLayout.offsetY && py <= minimapLayout.offsetY + minimapLayout.height;

  if (!withinX || !withinY || minimapLayout.scale <= 0) {
    return null;
  }

  return {
    x: (px - minimapLayout.offsetX) / minimapLayout.scale,
    y: (py - minimapLayout.offsetY) / minimapLayout.scale
  };
}

function getPointerGeometry(pointA, pointB) {
  const dx = pointB.x - pointA.x;
  const dy = pointB.y - pointA.y;
  return {
    distance: Math.hypot(dx, dy),
    centerX: (pointA.x + pointB.x) / 2,
    centerY: (pointA.y + pointB.y) / 2
  };
}

function getFirstTwoBoardPointers() {
  const pointerEntries = Array.from(boardPointers.entries());
  if (pointerEntries.length < 2) {
    return null;
  }

  const [firstId, firstPoint] = pointerEntries[0];
  const [secondId, secondPoint] = pointerEntries[1];
  return [
    { pointerId: firstId, ...firstPoint },
    { pointerId: secondId, ...secondPoint }
  ];
}

function startBoardDrag(pointerId, point) {
  boardGestureState = {
    type: "drag",
    pointerId,
    x: point.x,
    y: point.y
  };
  boardCanvas.classList.add("dragging");
}

function startBoardPinch(pointerA, pointerB) {
  const geometry = getPointerGeometry(pointerA, pointerB);
  boardGestureState = {
    type: "pinch",
    pointerAId: pointerA.pointerId,
    pointerBId: pointerB.pointerId,
    previousDistance: Math.max(geometry.distance, 1),
    previousCenterX: geometry.centerX,
    previousCenterY: geometry.centerY
  };
  boardCanvas.classList.remove("dragging");
}

function refreshBoardGestureState() {
  if (boardPointers.size === 0) {
    boardGestureState = null;
    boardCanvas.classList.remove("dragging");
    return;
  }

  if (boardPointers.size === 1) {
    const [pointerId, point] = boardPointers.entries().next().value;
    startBoardDrag(pointerId, point);
    return;
  }

  const pointers = getFirstTwoBoardPointers();
  if (!pointers) {
    boardGestureState = null;
    boardCanvas.classList.remove("dragging");
    return;
  }

  startBoardPinch(pointers[0], pointers[1]);
}

function findTouchById(touchList, touchId) {
  for (const touch of touchList) {
    if (touch.identifier === touchId) {
      return touch;
    }
  }
  return null;
}

function startBoardTouchDrag(touch) {
  boardTouchGestureState = {
    type: "drag",
    touchId: touch.identifier,
    x: touch.clientX,
    y: touch.clientY
  };
  boardCanvas.classList.add("dragging");
}

function startBoardTouchPinch(touchA, touchB) {
  const geometry = getPointerGeometry(
    { x: touchA.clientX, y: touchA.clientY },
    { x: touchB.clientX, y: touchB.clientY }
  );
  boardTouchGestureState = {
    type: "pinch",
    touchAId: touchA.identifier,
    touchBId: touchB.identifier,
    previousDistance: Math.max(geometry.distance, 1),
    previousCenterX: geometry.centerX,
    previousCenterY: geometry.centerY
  };
  boardCanvas.classList.remove("dragging");
}

function refreshTouchGestureFromTouches(touchList) {
  if (touchList.length === 0) {
    boardTouchGestureState = null;
    boardCanvas.classList.remove("dragging");
    return;
  }

  if (touchList.length === 1) {
    startBoardTouchDrag(touchList[0]);
    return;
  }

  startBoardTouchPinch(touchList[0], touchList[1]);
}

function applyEventBatch(events) {
  if (!board || !Array.isArray(events) || events.length === 0) {
    return 0;
  }

  const seenEventIds = new Set();
  let nextSeenId = lastSeenEventId;
  let newEvents = 0;
  let changedCells = 0;

  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== "object") {
      continue;
    }

    const eventId = parseEventId(rawEvent.id);
    if (eventId < 0 || eventId <= lastSeenEventId || seenEventIds.has(eventId)) {
      continue;
    }
    seenEventIds.add(eventId);
    nextSeenId = Math.max(nextSeenId, eventId);
    newEvents += 1;

    const x = rawEvent.x;
    const y = rawEvent.y;
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= board.width ||
      y >= board.height
    ) {
      continue;
    }

    const key = coordinateKey(x, y);
    const previous = cellMap.get(key);
    if (previous && parseEventId(previous.eventId) > eventId) {
      continue;
    }

    cellMap.set(key, {
      x,
      y,
      glyph: typeof rawEvent.glyph === "string" ? rawEvent.glyph : String(rawEvent.glyph ?? ""),
      color: typeof rawEvent.color === "string" ? rawEvent.color : "#111111",
      agentId: typeof rawEvent.agentId === "string" ? rawEvent.agentId : "unknown",
      updatedAt:
        typeof rawEvent.createdAt === "string" ? rawEvent.createdAt : new Date().toISOString(),
      eventId: String(rawEvent.id)
    });
    changedCells += 1;
  }

  if (newEvents > 0) {
    const base = Number.isSafeInteger(board.totalEvents) && board.totalEvents >= 0 ? board.totalEvents : 0;
    board.totalEvents = base + newEvents;
  }
  lastSeenEventId = Math.max(lastSeenEventId, nextSeenId);

  if (changedCells > 0) {
    board.cells = Array.from(cellMap.values());
  }

  return changedCells;
}

async function catchupEvents(sinceId) {
  if (!board || catchupInFlight || sinceId < 0) {
    return;
  }

  catchupInFlight = true;
  let cursor = sinceId;
  let shouldRender = false;

  try {
    while (true) {
      const response = await fetch(
        `/v1/pixel-events?sinceId=${encodeURIComponent(String(cursor))}&limit=${EVENT_PAGE_LIMIT}`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();
      const events = Array.isArray(json?.data) ? json.data : [];
      if (applyEventBatch(events) > 0) {
        shouldRender = true;
      }

      const page = json?.page && typeof json.page === "object" ? json.page : {};
      const nextSinceId = parseEventId(page.nextSinceId ?? null);
      const hasMore = page.hasMore === true;
      if (!hasMore || nextSinceId < 0 || nextSinceId <= cursor) {
        break;
      }
      cursor = nextSinceId;
    }
  } catch (error) {
    metaNode.textContent = `Live catch-up failed: ${error instanceof Error ? error.message : "unknown error"}`;
  } finally {
    catchupInFlight = false;
  }

  if (shouldRender) {
    render();
  }
}

let reconnectTimer = null;

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer !== null) {
    return;
  }
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    openEventStream();
  }, 1000);
}

function openEventStream() {
  if (!board || typeof EventSource !== "function") {
    return;
  }

  if (eventStream) {
    eventStream.close();
    eventStream = null;
  }

  const stream = new EventSource(
    `/v1/events/stream?sinceId=${encodeURIComponent(String(lastSeenEventId))}`
  );
  eventStream = stream;

  stream.addEventListener("hello", (message) => {
    if (eventStream !== stream) {
      return;
    }
    clearReconnectTimer();

    const payload = parseJsonSafe(message.data);
    if (!payload) {
      return;
    }

    const width = Number(payload.boardWidth);
    const height = Number(payload.boardHeight);
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      return;
    }

    const nextSizeKey = `${width}x${height}`;
    if (nextSizeKey !== boardSizeKey) {
      loadBoard();
    }
  });

  stream.addEventListener("events", (message) => {
    if (eventStream !== stream || !board) {
      return;
    }

    const payload = parseJsonSafe(message.data);
    if (!payload || !Array.isArray(payload.events)) {
      return;
    }

    const changedCells = applyEventBatch(payload.events);
    if (changedCells > 0) {
      render();
    }

    if (payload.hasMore === true) {
      const nextSinceId = parseEventId(payload.nextSinceId ?? null);
      if (nextSinceId >= 0) {
        catchupEvents(nextSinceId);
      }
    }
  });

  stream.addEventListener("error", () => {
    if (eventStream !== stream) {
      return;
    }
    stream.close();
    eventStream = null;
    scheduleReconnect();
  });
}

async function loadBoard() {
  try {
    const response = await fetch("/v1/board", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const json = await response.json();
    const nextBoard = json.data;
    const nextSizeKey = `${nextBoard.width}x${nextBoard.height}`;
    const sizeChanged = nextSizeKey !== boardSizeKey;
    boardSizeKey = nextSizeKey;

    cellMap = normalizeBoardCells(Array.isArray(nextBoard.cells) ? nextBoard.cells : []);
    nextBoard.cells = Array.from(cellMap.values());
    nextBoard.totalEvents =
      Number.isSafeInteger(nextBoard.totalEvents) && nextBoard.totalEvents >= 0
        ? nextBoard.totalEvents
        : 0;

    const restoredCamera = restoreCameraStateIfNeeded();
    applyBoardData(nextBoard, sizeChanged && !restoredCamera);
    lastSeenEventId = await resolveLatestEventId(nextBoard);
    render();
    scheduleCameraStateSave();
    openEventStream();
  } catch (error) {
    metaNode.textContent = `Failed to load: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}

boardCanvas.addEventListener("pointerdown", (event) => {
  if (!board || event.pointerType === "touch") {
    return;
  }

  boardPointers.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY
  });
  refreshBoardGestureState();
  boardCanvas.setPointerCapture(event.pointerId);
  event.preventDefault();
});

boardCanvas.addEventListener("pointermove", (event) => {
  if (!board || event.pointerType === "touch" || !boardPointers.has(event.pointerId)) {
    return;
  }

  boardPointers.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY
  });

  if (!boardGestureState) {
    refreshBoardGestureState();
    return;
  }

  if (boardGestureState.type === "drag") {
    if (boardGestureState.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - boardGestureState.x;
    const dy = event.clientY - boardGestureState.y;
    boardGestureState.x = event.clientX;
    boardGestureState.y = event.clientY;

    camera.x -= dx / camera.zoom;
    camera.y -= dy / camera.zoom;
    hasUserNavigated = true;
    clampCamera();
    render();
    scheduleCameraStateSave();
    event.preventDefault();
    return;
  }

  if (boardGestureState.type !== "pinch") {
    return;
  }

  const pointA = boardPointers.get(boardGestureState.pointerAId);
  const pointB = boardPointers.get(boardGestureState.pointerBId);
  if (!pointA || !pointB) {
    refreshBoardGestureState();
    return;
  }

  const geometry = getPointerGeometry(pointA, pointB);
  const currentDistance = Math.max(geometry.distance, 1);
  const zoomRate = currentDistance / boardGestureState.previousDistance;
  const nextZoom = clamp(camera.zoom * zoomRate, camera.minZoom, camera.maxZoom);
  const anchorWorldX = camera.x + boardGestureState.previousCenterX / camera.zoom;
  const anchorWorldY = camera.y + boardGestureState.previousCenterY / camera.zoom;

  camera.zoom = nextZoom;
  camera.x = anchorWorldX - geometry.centerX / camera.zoom;
  camera.y = anchorWorldY - geometry.centerY / camera.zoom;
  boardGestureState.previousDistance = currentDistance;
  boardGestureState.previousCenterX = geometry.centerX;
  boardGestureState.previousCenterY = geometry.centerY;

  hasUserNavigated = true;
  clampCamera();
  render();
  scheduleCameraStateSave();
  event.preventDefault();
});

function endBoardPointer(event) {
  if (event.pointerType === "touch" || !boardPointers.has(event.pointerId)) {
    return;
  }

  boardPointers.delete(event.pointerId);
  if (boardCanvas.hasPointerCapture(event.pointerId)) {
    boardCanvas.releasePointerCapture(event.pointerId);
  }
  refreshBoardGestureState();
}

boardCanvas.addEventListener("pointerup", endBoardPointer);
boardCanvas.addEventListener("pointercancel", endBoardPointer);

boardCanvas.addEventListener(
  "touchstart",
  (event) => {
    if (!board) {
      return;
    }
    refreshTouchGestureFromTouches(event.touches);
    event.preventDefault();
  },
  { passive: false }
);

boardCanvas.addEventListener(
  "touchmove",
  (event) => {
    if (!board || event.touches.length === 0) {
      return;
    }

    if (!boardTouchGestureState) {
      refreshTouchGestureFromTouches(event.touches);
      event.preventDefault();
      return;
    }

    if (boardTouchGestureState.type === "drag") {
      const touch =
        findTouchById(event.touches, boardTouchGestureState.touchId) ?? event.touches[0] ?? null;
      if (!touch) {
        refreshTouchGestureFromTouches(event.touches);
        event.preventDefault();
        return;
      }

      const dx = touch.clientX - boardTouchGestureState.x;
      const dy = touch.clientY - boardTouchGestureState.y;
      boardTouchGestureState.touchId = touch.identifier;
      boardTouchGestureState.x = touch.clientX;
      boardTouchGestureState.y = touch.clientY;

      camera.x -= dx / camera.zoom;
      camera.y -= dy / camera.zoom;
      hasUserNavigated = true;
      clampCamera();
      render();
      scheduleCameraStateSave();
      event.preventDefault();
      return;
    }

    if (boardTouchGestureState.type !== "pinch") {
      event.preventDefault();
      return;
    }

    const touchA = findTouchById(event.touches, boardTouchGestureState.touchAId);
    const touchB = findTouchById(event.touches, boardTouchGestureState.touchBId);

    if (!touchA || !touchB) {
      refreshTouchGestureFromTouches(event.touches);
      event.preventDefault();
      return;
    }

    const geometry = getPointerGeometry(
      { x: touchA.clientX, y: touchA.clientY },
      { x: touchB.clientX, y: touchB.clientY }
    );
    const currentDistance = Math.max(geometry.distance, 1);
    const zoomRate = currentDistance / boardTouchGestureState.previousDistance;
    const nextZoom = clamp(camera.zoom * zoomRate, camera.minZoom, camera.maxZoom);
    const anchorWorldX = camera.x + boardTouchGestureState.previousCenterX / camera.zoom;
    const anchorWorldY = camera.y + boardTouchGestureState.previousCenterY / camera.zoom;

    camera.zoom = nextZoom;
    camera.x = anchorWorldX - geometry.centerX / camera.zoom;
    camera.y = anchorWorldY - geometry.centerY / camera.zoom;
    boardTouchGestureState.previousDistance = currentDistance;
    boardTouchGestureState.previousCenterX = geometry.centerX;
    boardTouchGestureState.previousCenterY = geometry.centerY;

    hasUserNavigated = true;
    clampCamera();
    render();
    scheduleCameraStateSave();
    event.preventDefault();
  },
  { passive: false }
);

function endBoardTouch(event) {
  if (!board) {
    return;
  }
  refreshTouchGestureFromTouches(event.touches);
  event.preventDefault();
}

boardCanvas.addEventListener("touchend", endBoardTouch, { passive: false });
boardCanvas.addEventListener("touchcancel", endBoardTouch, { passive: false });

boardCanvas.addEventListener(
  "wheel",
  (event) => {
    if (!board) {
      return;
    }
    event.preventDefault();

    const rect = boardCanvas.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const zoomRate = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = clamp(camera.zoom * zoomRate, camera.minZoom, camera.maxZoom);

    if (nextZoom === camera.zoom) {
      return;
    }

    const worldX = camera.x + cursorX / camera.zoom;
    const worldY = camera.y + cursorY / camera.zoom;

    camera.zoom = nextZoom;
    camera.x = worldX - cursorX / camera.zoom;
    camera.y = worldY - cursorY / camera.zoom;
    hasUserNavigated = true;
    clampCamera();
    render();
    scheduleCameraStateSave();
  },
  { passive: false }
);

minimapCanvas.addEventListener("pointerdown", (event) => {
  if (!board) {
    return;
  }
  minimapDraggingPointerId = event.pointerId;
  minimapCanvas.setPointerCapture(event.pointerId);
  const worldPoint = minimapEventToWorld(event);
  if (!worldPoint) {
    return;
  }
  moveCameraToWorldCenter(worldPoint.x, worldPoint.y);
  hasUserNavigated = true;
  render();
  scheduleCameraStateSave();
});

minimapCanvas.addEventListener("pointermove", (event) => {
  if (!board || minimapDraggingPointerId !== event.pointerId) {
    return;
  }
  const worldPoint = minimapEventToWorld(event);
  if (!worldPoint) {
    return;
  }
  moveCameraToWorldCenter(worldPoint.x, worldPoint.y);
  hasUserNavigated = true;
  render();
  scheduleCameraStateSave();
});

function endMinimapDrag(event) {
  if (minimapDraggingPointerId !== event.pointerId) {
    return;
  }
  minimapCanvas.releasePointerCapture(event.pointerId);
  minimapDraggingPointerId = null;
}

minimapCanvas.addEventListener("pointerup", endMinimapDrag);
minimapCanvas.addEventListener("pointercancel", endMinimapDrag);

window.addEventListener("resize", () => {
  if (!board) {
    refreshCanvasSize();
    return;
  }
  refreshCanvasSize();
  updateZoomBounds();
  if (!hasUserNavigated) {
    fitBoardToViewport();
  } else {
    clampCamera();
  }
  render();
  scheduleCameraStateSave();
});

window.addEventListener("pagehide", () => {
  clearCameraSaveTimer();
  writeCameraState();
  clearReconnectTimer();
  if (eventStream) {
    eventStream.close();
    eventStream = null;
  }
});

refreshCanvasSize();
loadBoard();
