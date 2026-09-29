import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

// =============================================================================
// CAMBIO DE ESTA VERSIÓN: VIDEO REMOTO NEGRO EN LA VIDEOLLAMADA
//
// Síntoma: el estado decía "Llamada en curso" (o sea, la conexión SÍ se
// establecía y el video SÍ llegaba), pero el recuadro se veía negro/vacío.
//
// Causa: los navegadores bloquean la reproducción automática de un <video>
// que tiene sonido si no viene de un clic directo justo en ese instante.
// El lado que RECIBE la llamada asigna el video de forma asíncrona (después
// de negociar la conexión con el otro), no directamente dentro de un
// evento de clic — así que el navegador lo deja con la imagen asignada
// pero nunca lo reproduce. Por fuera, eso se ve exactamente como un
// recuadro negro aunque todo lo demás funcione bien.
//
// Arreglo: ahora se llama explícitamente a .play() al recibir el video. Si
// el navegador lo bloquea por tener sonido, se reintenta SILENCIADO (eso sí
// lo permite cualquier navegador) y se le avisa al usuario que toque el
// video para activar el audio — un toque sí cuenta como interacción
// directa, así que ahí sí se puede activar el sonido sin problema.
//
// También se agregaron varios servidores STUN públicos adicionales (antes
// solo se usaba el que trae PeerJS por defecto) para mejorar las
// probabilidades de conectar cuando alguna de las dos redes tiene un NAT
// más restrictivo (redes móviles, wifi de oficina, etc.).
// =============================================================================

// ---------------- Instalable como app (PWA) ----------------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((error) => {
      console.error("No se pudo registrar el service worker:", error);
    });
  });
}

let deferredInstallPrompt = null;
const installAppButton = document.getElementById("install-app-button");

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installAppButton.style.display = "";
});

installAppButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installAppButton.style.display = "none";
});

window.addEventListener("appinstalled", () => {
  installAppButton.style.display = "none";
  deferredInstallPrompt = null;
});

// ---------------- Modo desarrollador ----------------

const DEVELOPER_MODE_KEY = "openhands-developer-mode";
const DEVELOPER_MODE_CODE = "TRALAKOMONOV";

const openTrainingPanelButton = document.getElementById("open-training-panel");

function isDeveloperModeEnabled() {
  return localStorage.getItem(DEVELOPER_MODE_KEY) === "true";
}

function applyDeveloperModeVisibility() {
  openTrainingPanelButton.style.display = isDeveloperModeEnabled() ? "" : "none";
}

function enableDeveloperMode() {
  localStorage.setItem(DEVELOPER_MODE_KEY, "true");
  applyDeveloperModeVisibility();
  alert("Modo desarrollador activado. Ya puedes ver 'Entrenar señas' en el menú de arriba.");
}

applyDeveloperModeVisibility();

// ---------------- Modo mesa ----------------

const appRoot = document.getElementById("app-root");
const tableModeButton = document.getElementById("table-mode-button");

let isTableMode = false;

function toggleTableMode() {
  isTableMode = !isTableMode;
  appRoot.classList.toggle("table-mode", isTableMode);
  tableModeButton.classList.toggle("btn-primary", isTableMode);
}

tableModeButton.addEventListener("click", toggleTableMode);

// ---------------- Cámara ----------------

const cameraPreview = document.getElementById("camera-preview");
const cameraPlaceholder = document.getElementById("camera-placeholder");
const cameraToggleButton = document.getElementById("camera-toggle-button");
const globalStatus = document.getElementById("global-status");

let cameraStream = null;

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cameraPlaceholder.textContent = "Este navegador no soporta acceso a cámara.";
    cameraPlaceholder.style.display = "flex";
    return;
  }

  try {
    // 640x480 en vez de 1280x720: MediaPipe reescala internamente la
    // imagen para detectar las manos, así que una resolución más alta no
    // mejora la detección — solo le agrega trabajo de cámara/CPU a cada
    // fotograma, lo que le resta fluidez (FPS) al reconocimiento en vivo.
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });

    cameraPreview.srcObject = cameraStream;
    cameraPlaceholder.style.display = "none";
    cameraToggleButton.classList.remove("off");
    globalStatus.textContent = "cámara activa, esperando actividad…";
  } catch (error) {
    console.error("No se pudo acceder a la cámara:", error);
    cameraStream = null;

    if (error.name === "NotAllowedError") {
      cameraPlaceholder.textContent = "Permiso de cámara denegado. Actívalo en la configuración del navegador.";
    } else if (error.name === "NotFoundError") {
      cameraPlaceholder.textContent = "No se encontró ninguna cámara conectada.";
    } else {
      cameraPlaceholder.textContent = "No se pudo acceder a la cámara.";
    }

    cameraPlaceholder.style.display = "flex";
    cameraToggleButton.classList.add("off");
    globalStatus.textContent = "error al acceder a la cámara";
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  cameraPreview.srcObject = null;
  cameraPlaceholder.textContent = "Cámara desactivada";
  cameraPlaceholder.style.display = "flex";
  cameraToggleButton.classList.add("off");
  globalStatus.textContent = "cámara desactivada";
  handStatus.textContent = "sin mano detectada";
  landmarksInfo.textContent = "Sin manos detectadas — vector de landmarks no disponible.";
  handCanvasCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
  resetHandTracks();
  lastNormalizedVector = null;
  smoothedVectorState = null;
  hasSeenAnyHandEver = false;
}

cameraToggleButton.addEventListener("click", () => {
  if (cameraStream) {
    stopCamera();
  } else {
    startCamera();
  }
});

startCamera();

// ---------------- Micrófono + reconocimiento de voz ----------------

const micButton = document.getElementById("mic-button");
const micStatus = document.getElementById("mic-status");
const listenerSpeechText = document.getElementById("listener-speech-text");

const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let isMicOn = false;

function createRecognition() {
  const instance = new SpeechRecognitionClass();
  instance.continuous = true;
  instance.interimResults = true;
  instance.lang = "es-ES";

  instance.onresult = (event) => {
    let finalText = "";
    let interimText = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalText += transcript;
      } else {
        interimText += transcript;
      }
    }

    if (finalText.trim()) {
      listenerSpeechText.textContent = finalText.trim();
      sendCallData({ type: "speech_final", text: finalText.trim() });
    } else if (interimText.trim()) {
      listenerSpeechText.textContent = interimText.trim();
    }
  };

  instance.onerror = (event) => {
    console.error("Error de reconocimiento de voz:", event.error);
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      micStatus.textContent = "permiso de micrófono denegado";
    } else if (event.error === "network") {
      micStatus.textContent = "error de red al transcribir (revisa tu conexión a internet)";
    }
    stopMic();
  };

  instance.onend = () => {
    if (isMicOn) {
      try {
        instance.start();
      } catch (error) {
        // ya estaba iniciado, se ignora
      }
    }
  };

  return instance;
}

function startMic() {
  if (!SpeechRecognitionClass) {
    micStatus.textContent = "este navegador no soporta reconocimiento de voz";
    return;
  }

  if (!recognition) {
    recognition = createRecognition();
  }

  try {
    recognition.start();
    isMicOn = true;
    micButton.classList.add("active");
    micStatus.textContent = "micrófono encendido, escuchando…";
  } catch (error) {
    console.error("No se pudo iniciar el reconocimiento de voz:", error);
  }
}

function stopMic() {
  isMicOn = false;
  if (recognition) {
    recognition.stop();
  }
  micButton.classList.remove("active");
  micStatus.textContent = "micrófono apagado";
}

micButton.addEventListener("click", () => {
  if (isMicOn) {
    stopMic();
  } else {
    startMic();
  }
});

// ---------------- Detección de manos (MediaPipe) ----------------

const handCanvas = document.getElementById("hand-canvas");
const handCanvasCtx = handCanvas.getContext("2d");
const handStatus = document.getElementById("hand-status");
const landmarksInfo = document.getElementById("landmarks-info");

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

let handLandmarker = null;

// ---------------- Rendimiento de detección ----------------
// detectForVideo() es una llamada síncrona y pesada. Antes se ejecutaba en
// CADA frame de pantalla (hasta 60/seg) sin límite — eso satura el hilo
// principal. Con ~24 detecciones/seg alcanza de sobra para reconocer señas
// con fluidez.
const TARGET_DETECTION_FPS = 24;
const DETECTION_INTERVAL_MS = 1000 / TARGET_DETECTION_FPS;
let lastDetectionTimestamp = 0;

async function initHandLandmarker() {
  try {
    globalStatus.textContent = "cargando detector de manos…";

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );

    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
      // minHandDetectionConfidence: umbral del detector de PALMA, usado
      // SOLO para encontrar una mano nueva desde cero. Con 0.4 la segunda
      // mano seguía tardando (su confianza inicial es naturalmente más
      // baja que la primera). Lo bajamos otro poco a 0.35 — nos apoyamos
      // en MIN_HANDEDNESS_SCORE (más abajo) para seguir filtrando
      // falsos positivos, en vez de cargarle todo el trabajo a este único
      // número. Si vuelves a ver cara/hombros detectados como mano, este
      // es el primer número que hay que subir de nuevo.
      minHandDetectionConfidence: 0.35,
      minHandPresenceConfidence: 0.15,
      minTrackingConfidence: 0.15,
    });

    globalStatus.textContent = "cámara activa, esperando actividad…";
    requestAnimationFrame(predictLoop);
  } catch (error) {
    console.error("No se pudo cargar el detector de manos:", error);
    globalStatus.textContent = "error al cargar el detector de manos (revisa tu conexión a internet)";
  }
}

function resizeCanvasToVideo() {
  if (cameraPreview.videoWidth && handCanvas.width !== cameraPreview.videoWidth) {
    handCanvas.width = cameraPreview.videoWidth;
    handCanvas.height = cameraPreview.videoHeight;
  }
}

function getDisplayScale() {
  if (!handCanvas.clientWidth || !handCanvas.width) return 1;
  return handCanvas.clientWidth / handCanvas.width;
}

function drawHands(results) {
  resizeCanvasToVideo();
  handCanvasCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);

  const hands = results.landmarks || [];
  handStatus.textContent =
    hands.length === 0 ? "sin mano detectada" : `manos detectadas: ${hands.length}`;

  const scale = getDisplayScale();
  const outlineWidth = 2.5 / scale;
  const lineWidth = 1.2 / scale;
  const pointRadius = 2.2 / scale;
  const pointBorder = 0.8 / scale;

  for (const landmarks of hands) {
    for (const [a, b] of HAND_CONNECTIONS) {
      const pointA = landmarks[a];
      const pointB = landmarks[b];
      const x1 = pointA.x * handCanvas.width;
      const y1 = pointA.y * handCanvas.height;
      const x2 = pointB.x * handCanvas.width;
      const y2 = pointB.y * handCanvas.height;

      handCanvasCtx.beginPath();
      handCanvasCtx.moveTo(x1, y1);
      handCanvasCtx.lineTo(x2, y2);
      handCanvasCtx.strokeStyle = "#000000";
      handCanvasCtx.lineWidth = outlineWidth;
      handCanvasCtx.lineCap = "round";
      handCanvasCtx.stroke();

      handCanvasCtx.beginPath();
      handCanvasCtx.moveTo(x1, y1);
      handCanvasCtx.lineTo(x2, y2);
      handCanvasCtx.strokeStyle = "#22d3aa";
      handCanvasCtx.lineWidth = lineWidth;
      handCanvasCtx.lineCap = "round";
      handCanvasCtx.stroke();
    }

    for (const point of landmarks) {
      const x = point.x * handCanvas.width;
      const y = point.y * handCanvas.height;

      handCanvasCtx.beginPath();
      handCanvasCtx.arc(x, y, pointRadius, 0, 2 * Math.PI);
      handCanvasCtx.fillStyle = "#f5a623";
      handCanvasCtx.fill();
      handCanvasCtx.lineWidth = pointBorder;
      handCanvasCtx.strokeStyle = "#ffffff";
      handCanvasCtx.stroke();
    }
  }
}

// ---------------- Extracción y normalización de landmarks ----------------

const MIN_HAND_SIZE_THRESHOLD = 0.02;

// Segundo filtro, independiente del tamaño y de minHandDetectionConfidence:
// MediaPipe también calcula, para cada detección, qué tan seguro está de
// que es una mano IZQUIERDA o DERECHA (handedness.score). Una cara u hombro
// que logra colarse como "mano" casi siempre tiene esa confianza más baja o
// inestable de un frame a otro que una mano real — aunque haya pasado el
// umbral de detección de palma. Lo usamos como filtro extra, más barato que
// subir minHandDetectionConfidence (que ya vimos que retrasa la segunda
// mano). Si sigues viendo falsos positivos, sube este número; si empieza a
// rechazar manos reales en ángulos raros, bájalo.
const MIN_HANDEDNESS_SCORE = 0.6;

function computeHandSizeInFrame(landmarks) {
  const wrist = landmarks[0];
  let maxDistance = 0;
  for (const p of landmarks) {
    const dx = p.x - wrist.x;
    const dy = p.y - wrist.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > maxDistance) maxDistance = distance;
  }
  return maxDistance;
}

// ---------------- Seguimiento estable de manos (pistas / tracks) ----------------

// Antes esto era un conteo de frames asumiendo ~60 FPS de detección. Ahora
// que la detección está limitada a TARGET_DETECTION_FPS, medimos en tiempo
// real para que el comportamiento no dependa de ese número.
const HAND_TRACK_MAX_MISSING_MS = 250; // ~15 frames a 60 FPS, en tiempo real
const MIRROR_VOTE_WINDOW = 7;

const VELOCITY_NORMALIZATION_SCALE = 4;
const MIN_VELOCITY_DT_SECONDS = 0.01;

function createEmptyTrack() {
  return {
    active: false,
    wrist: null,
    handednessLabel: null,
    mirrorSign: null,
    mirrorVotes: [],
    lastUpdateTimestamp: null,
    velocity: { vx: 0, vy: 0 },
    consecutiveFrames: 0,
  };
}

// Un falso positivo típico (cara, hombro, un ángulo raro) casi siempre
// aparece 1 solo frame y desaparece; una mano real se mantiene detectada
// frame tras frame. Exigimos 2 detecciones seguidas antes de dibujar/usar
// una pista NUEVA, sin tener que subir tanto la confianza como para perder
// manos reales. A ~24 detecciones/seg, 2 frames son ~80ms — imperceptible.
const HAND_CONFIRMATION_FRAMES = 2;

function isTrackConfirmed(track) {
  return track.active && track.consecutiveFrames >= HAND_CONFIRMATION_FRAMES;
}

let handTracks = [createEmptyTrack(), createEmptyTrack()];

function resetHandTracks() {
  handTracks = [createEmptyTrack(), createEmptyTrack()];
}

function distanceBetweenPoints(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Margen que debe sacarle la lateralidad "nueva" a la ya establecida para
// que la pista cambie de Izquierda↔Derecha. Sin esto, una lectura ambigua
// puntual (muy común en ángulos raros) podía voltear la lateralidad A
// MITAD de una seña — y como el "modo espejo" depende de saber de forma
// estable cuál mano es cuál para invertir correctamente las coordenadas,
// ese cambio a mitad de camino arruina tanto el reconocimiento normal como
// el reconocimiento "en espejo" con la otra mano.
const MIRROR_SWITCH_MARGIN = 1.3;

function pushMirrorVote(track, label, score) {
  const safeLabel = label || track.handednessLabel || "Right";
  // MediaPipe entrega, junto con Left/Right, qué tan seguro está de esa
  // clasificación (handedness.score). Antes cada voto contaba igual sin
  // importar si venía de un frame muy claro o de uno ambiguo — ahora
  // pesamos cada voto por esa confianza, así una lectura dudosa influye
  // menos que una clara.
  const safeWeight = typeof score === "number" && score > 0 ? score : 0.5;

  track.mirrorVotes.push({ label: safeLabel, weight: safeWeight });
  if (track.mirrorVotes.length > MIRROR_VOTE_WINDOW) track.mirrorVotes.shift();

  const tally = {};
  for (const v of track.mirrorVotes) tally[v.label] = (tally[v.label] || 0) + v.weight;

  let bestLabel = safeLabel;
  let bestWeight = -Infinity;
  for (const [l, w] of Object.entries(tally)) {
    if (w > bestWeight) {
      bestWeight = w;
      bestLabel = l;
    }
  }

  if (track.handednessLabel && track.handednessLabel !== bestLabel) {
    const currentWeight = tally[track.handednessLabel] || 0;
    if (bestWeight < currentWeight * MIRROR_SWITCH_MARGIN) {
      bestLabel = track.handednessLabel; // no hay margen suficiente: no cambia
    }
  }

  track.handednessLabel = bestLabel;
  track.mirrorSign = bestLabel === "Left" ? 1 : -1;
}

function computeTrackVelocity(track, currentWrist, currentHandSize, nowMs) {
  if (track.lastUpdateTimestamp === null || !track.wrist) {
    return { vx: 0, vy: 0 };
  }
  const dtSeconds = Math.max((nowMs - track.lastUpdateTimestamp) / 1000, MIN_VELOCITY_DT_SECONDS);
  const scale = currentHandSize || 1e-6;
  const rawVx = (currentWrist.x - track.wrist.x) / dtSeconds / scale;
  const rawVy = (currentWrist.y - track.wrist.y) / dtSeconds / scale;
  return {
    vx: Math.max(-1, Math.min(1, rawVx / VELOCITY_NORMALIZATION_SCALE)),
    vy: Math.max(-1, Math.min(1, rawVy / VELOCITY_NORMALIZATION_SCALE)),
  };
}

function updateTrackFromHand(track, landmarks, handednessLabel, handednessScore, nowMs) {
  const currentWrist = { x: landmarks[0].x, y: landmarks[0].y };
  const currentHandSize = computeHandSizeInFrame(landmarks);
  const wasActive = track.active;

  track.velocity = computeTrackVelocity(track, currentWrist, currentHandSize, nowMs);

  track.active = true;
  track.wrist = currentWrist;
  track.lastUpdateTimestamp = nowMs;
  track.consecutiveFrames = wasActive ? track.consecutiveFrames + 1 : 1;
  pushMirrorVote(track, handednessLabel, handednessScore);
}

function markTrackMissing(track, nowMs) {
  if (!track.active) return;
  if (nowMs - track.lastUpdateTimestamp > HAND_TRACK_MAX_MISSING_MS) {
    track.active = false;
    track.wrist = null;
    track.handednessLabel = null;
    track.mirrorSign = null;
    track.mirrorVotes = [];
    track.lastUpdateTimestamp = null;
    track.velocity = { vx: 0, vy: 0 };
    track.consecutiveFrames = 0;
  }
}

function assignHandsToTracks(handsLandmarks, handednessList, nowMs) {
  const numHands = handsLandmarks.length;
  const assignment = [null, null];

  if (numHands === 0) {
    markTrackMissing(handTracks[0], nowMs);
    markTrackMissing(handTracks[1], nowMs);
    return assignment;
  }

  const labels = handsLandmarks.map((_, i) => {
    const h = handednessList && handednessList[i] && handednessList[i][0];
    return h ? h.categoryName : null;
  });
  const scores = handsLandmarks.map((_, i) => {
    const h = handednessList && handednessList[i] && handednessList[i][0];
    return h ? h.score : 0;
  });

  if (numHands === 1) {
    const wrist = handsLandmarks[0][0];
    let targetIndex = 0;

    if (handTracks[0].active && handTracks[1].active) {
      const d0 = distanceBetweenPoints(wrist, handTracks[0].wrist);
      const d1 = distanceBetweenPoints(wrist, handTracks[1].wrist);
      targetIndex = d0 <= d1 ? 0 : 1;
    } else if (handTracks[1].active && !handTracks[0].active) {
      targetIndex = 1;
    } else {
      targetIndex = 0;
    }

    updateTrackFromHand(handTracks[targetIndex], handsLandmarks[0], labels[0], scores[0], nowMs);
    assignment[targetIndex] = { landmarks: handsLandmarks[0], track: handTracks[targetIndex] };
    markTrackMissing(handTracks[1 - targetIndex], nowMs);
    return assignment;
  }

  const handA = handsLandmarks[0];
  const handB = handsLandmarks[1];
  const labelA = labels[0];
  const labelB = labels[1];
  const scoreA = scores[0];
  const scoreB = scores[1];

  if (handTracks[0].active || handTracks[1].active) {
    const costNormal =
      (handTracks[0].active ? distanceBetweenPoints(handA[0], handTracks[0].wrist) : 0) +
      (handTracks[1].active ? distanceBetweenPoints(handB[0], handTracks[1].wrist) : 0);
    const costSwapped =
      (handTracks[0].active ? distanceBetweenPoints(handB[0], handTracks[0].wrist) : 0) +
      (handTracks[1].active ? distanceBetweenPoints(handA[0], handTracks[1].wrist) : 0);

    if (costSwapped < costNormal) {
      updateTrackFromHand(handTracks[0], handB, labelB, scoreB, nowMs);
      updateTrackFromHand(handTracks[1], handA, labelA, scoreA, nowMs);
      assignment[0] = { landmarks: handB, track: handTracks[0] };
      assignment[1] = { landmarks: handA, track: handTracks[1] };
      return assignment;
    }
  }

  updateTrackFromHand(handTracks[0], handA, labelA, scoreA, nowMs);
  updateTrackFromHand(handTracks[1], handB, labelB, scoreB, nowMs);
  assignment[0] = { landmarks: handA, track: handTracks[0] };
  assignment[1] = { landmarks: handB, track: handTracks[1] };
  return assignment;
}

function normalizeLandmarks(landmarks, mirrorSign) {
  const wrist = landmarks[0];
  const sign = mirrorSign || 1;

  const translated = landmarks.map((p) => ({
    x: (p.x - wrist.x) * sign,
    y: p.y - wrist.y,
    z: p.z - wrist.z,
  }));

  let maxDistance = 0;
  for (const p of translated) {
    const distance = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    if (distance > maxDistance) maxDistance = distance;
  }
  const scale = maxDistance > 1e-6 ? maxDistance : 1e-6;

  const normalized = [];
  for (const p of translated) {
    normalized.push(p.x / scale, p.y / scale, p.z / scale);
  }
  return normalized;
}

function computeRelativeHandPosition(landmarksA, landmarksB, mirrorA) {
  const wristA = landmarksA[0];
  const wristB = landmarksB[0];
  const sizeA = computeHandSizeInFrame(landmarksA);
  const sizeB = computeHandSizeInFrame(landmarksB);
  const combinedScale = (sizeA + sizeB) / 2 || 1e-6;
  const sign = mirrorA || 1;

  return [
    ((wristB.x - wristA.x) * sign) / combinedScale,
    (wristB.y - wristA.y) / combinedScale,
    (wristB.z - wristA.z) / combinedScale,
  ];
}

// ---------------- Curvatura por dedo ----------------

const FINGER_ANGLE_JOINTS = [
  [2, 3, 4],
  [5, 6, 8],
  [9, 10, 12],
  [13, 14, 16],
  [17, 18, 20],
];

// ---------------- Formatos del vector (historial, para migración) ----------------

const COORDS_LENGTH = 63;
const CURL_FEATURE_COUNT = FINGER_ANGLE_JOINTS.length;
const VELOCITY_FEATURE_COUNT = 2;
const RELATIVE_POSITION_LENGTH = 3;

const HAND_VECTOR_LENGTH_V1 = COORDS_LENGTH;
const HAND_VECTOR_LENGTH_V2 = COORDS_LENGTH + CURL_FEATURE_COUNT;
const HAND_VECTOR_LENGTH = HAND_VECTOR_LENGTH_V2 + VELOCITY_FEATURE_COUNT;

const TWO_HAND_VECTOR_LENGTH_V1 = HAND_VECTOR_LENGTH_V1 * 2 + RELATIVE_POSITION_LENGTH;
const TWO_HAND_VECTOR_LENGTH_V2 = HAND_VECTOR_LENGTH_V2 * 2 + RELATIVE_POSITION_LENGTH;
const TWO_HAND_VECTOR_LENGTH = HAND_VECTOR_LENGTH * 2 + RELATIVE_POSITION_LENGTH;

function getPointFromFlatCoords(coordsFlat, pointIndex) {
  return {
    x: coordsFlat[pointIndex * 3 + 0],
    y: coordsFlat[pointIndex * 3 + 1],
    z: coordsFlat[pointIndex * 3 + 2],
  };
}

function angleCosineAtJoint(basePoint, jointPoint, tipPoint) {
  const v1 = {
    x: basePoint.x - jointPoint.x,
    y: basePoint.y - jointPoint.y,
    z: basePoint.z - jointPoint.z,
  };
  const v2 = {
    x: tipPoint.x - jointPoint.x,
    y: tipPoint.y - jointPoint.y,
    z: tipPoint.z - jointPoint.z,
  };
  const len1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y + v1.z * v1.z) || 1e-6;
  const len2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y + v2.z * v2.z) || 1e-6;
  const dot = (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / (len1 * len2);
  return Math.max(-1, Math.min(1, dot));
}

function computeCurlFeatures(coordsFlat) {
  return FINGER_ANGLE_JOINTS.map(([baseIdx, jointIdx, tipIdx]) => {
    const basePoint = getPointFromFlatCoords(coordsFlat, baseIdx);
    const jointPoint = getPointFromFlatCoords(coordsFlat, jointIdx);
    const tipPoint = getPointFromFlatCoords(coordsFlat, tipIdx);
    return angleCosineAtJoint(basePoint, jointPoint, tipPoint);
  });
}

function buildHandFeatureVector(landmarks, mirrorSign, velocity) {
  const coords = normalizeLandmarks(landmarks, mirrorSign);
  const curl = computeCurlFeatures(coords);
  const sign = mirrorSign || 1;
  const vx = velocity ? velocity.vx * sign : 0;
  const vy = velocity ? velocity.vy : 0;
  return [...coords, ...curl, vx, vy];
}

// ---------------- Suavizado temporal del vector de landmarks ----------------
const SMOOTHING_ALPHA = 0.55;
let smoothedVectorState = null;

function smoothVector(vector) {
  if (!smoothedVectorState || smoothedVectorState.length !== vector.length) {
    smoothedVectorState = vector.slice();
    return smoothedVectorState.slice();
  }
  const result = new Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    result[i] = smoothedVectorState[i] * SMOOTHING_ALPHA + vector[i] * (1 - SMOOTHING_ALPHA);
  }
  smoothedVectorState = result;
  return result.slice();
}

function updateLandmarksInfo(vector, handednessLabel) {
  if (!vector) {
    landmarksInfo.textContent = "Sin manos detectadas — vector de landmarks no disponible.";
    return;
  }

  const labelEs =
    handednessLabel === "Left" ? "izquierda" : handednessLabel === "Right" ? "derecha" : "desconocida";

  const fingertipIndex = 8;
  const fx = vector[fingertipIndex * 3 + 0];
  const fy = vector[fingertipIndex * 3 + 1];
  const fz = vector[fingertipIndex * 3 + 2];

  landmarksInfo.textContent =
    `Mano detectada (lateralidad: ${labelEs}) — vector normalizado: ${vector.length} valores | ` +
    `punta índice (p8): x=${fx.toFixed(2)}, y=${fy.toFixed(2)}, z=${fz.toFixed(2)}`;
}

// ---------------- Aumento de datos: rotaciones sintéticas ----------------

function randomRotationMatrix(maxDegrees) {
  const maxRad = (maxDegrees * Math.PI) / 180;
  const rx = (Math.random() * 2 - 1) * maxRad;
  const ry = (Math.random() * 2 - 1) * maxRad;
  const rz = (Math.random() * 2 - 1) * maxRad;

  const cosX = Math.cos(rx), sinX = Math.sin(rx);
  const cosY = Math.cos(ry), sinY = Math.sin(ry);
  const cosZ = Math.cos(rz), sinZ = Math.sin(rz);

  const rotX = [[1, 0, 0], [0, cosX, -sinX], [0, sinX, cosX]];
  const rotY = [[cosY, 0, sinY], [0, 1, 0], [-sinY, 0, cosY]];
  const rotZ = [[cosZ, -sinZ, 0], [sinZ, cosZ, 0], [0, 0, 1]];

  function multiply(a, b) {
    const result = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) {
          result[i][j] += a[i][k] * b[k][j];
        }
      }
    }
    return result;
  }

  return multiply(multiply(rotZ, rotY), rotX);
}

function rotateHandCoords(coordsFlat, matrix) {
  const rotated = [];
  for (let i = 0; i < 21; i++) {
    const x = coordsFlat[i * 3 + 0];
    const y = coordsFlat[i * 3 + 1];
    const z = coordsFlat[i * 3 + 2];
    rotated.push(
      matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z,
      matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z,
      matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z
    );
  }
  return rotated;
}

const AUGMENTATION_COPIES = 3;
const AUGMENTATION_MAX_DEGREES = 30;
const AUGMENTATION_NOISE_STD = 0.015;
const CURL_NOISE_STD = 0.03;
const VELOCITY_NOISE_STD = 0.05;

function jitterCoords(coordsFlat) {
  return coordsFlat.map((v) => v + (Math.random() * 2 - 1) * AUGMENTATION_NOISE_STD);
}

function jitterCurl(curlValues) {
  return curlValues.map((v) => Math.max(-1, Math.min(1, v + (Math.random() * 2 - 1) * CURL_NOISE_STD)));
}

function jitterVelocity(velocityValues) {
  return velocityValues.map((v) => Math.max(-1, Math.min(1, v + (Math.random() * 2 - 1) * VELOCITY_NOISE_STD)));
}

// Rota un vector 3D (x,y,z) por la matriz dada. Se usa para relPos (la
// posición relativa entre las dos manos) cuando se aumenta una muestra de
// dos manos, para que quede geométricamente consistente con la MISMA
// rotación de cámara sintética que se le aplica a ambas manos.
function rotateVector3(vec3, matrix) {
  const [x, y, z] = vec3;
  return [
    matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z,
    matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z,
    matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z,
  ];
}

function augmentHandFeatureVectorWithMatrix(handFeatureVector, matrix) {
  const coords = handFeatureVector.slice(0, COORDS_LENGTH);
  const curl = handFeatureVector.slice(COORDS_LENGTH, COORDS_LENGTH + CURL_FEATURE_COUNT);
  const velocity = handFeatureVector.slice(COORDS_LENGTH + CURL_FEATURE_COUNT);

  const rotatedCoords = rotateHandCoords(coords, matrix);
  const noisyCoords = jitterCoords(rotatedCoords);
  const noisyCurl = jitterCurl(curl);
  const noisyVelocity = jitterVelocity(velocity);

  return [...noisyCoords, ...noisyCurl, ...noisyVelocity];
}

function augmentHandFeatureVector(handFeatureVector) {
  const matrix = randomRotationMatrix(AUGMENTATION_MAX_DEGREES);
  return augmentHandFeatureVectorWithMatrix(handFeatureVector, matrix);
}

function augmentSample(vector) {
  const augmented = [];

  if (vector.length === HAND_VECTOR_LENGTH) {
    for (let c = 0; c < AUGMENTATION_COPIES; c++) {
      augmented.push(augmentHandFeatureVector(vector));
    }
    return augmented;
  }

  if (vector.length === TWO_HAND_VECTOR_LENGTH) {
    const featA = vector.slice(0, HAND_VECTOR_LENGTH);
    const featB = vector.slice(HAND_VECTOR_LENGTH, HAND_VECTOR_LENGTH * 2);
    const relPos = vector.slice(HAND_VECTOR_LENGTH * 2);

    for (let c = 0; c < AUGMENTATION_COPIES; c++) {
      const matrix = randomRotationMatrix(AUGMENTATION_MAX_DEGREES);
      const augA = augmentHandFeatureVectorWithMatrix(featA, matrix);
      const augB = augmentHandFeatureVectorWithMatrix(featB, matrix);
      const rotatedRelPos = rotateVector3(relPos, matrix);
      const jitteredRelPos = rotatedRelPos.map(
        (v) => v + (Math.random() * 2 - 1) * AUGMENTATION_NOISE_STD
      );
      augmented.push([...augA, ...augB, ...jitteredRelPos]);
    }
    return augmented;
  }

  console.warn(`augmentSample: longitud de vector no reconocida (${vector.length}).`);
  return augmented;
}

// ---------------- Panel "Entrenar señas" ----------------

const trainingPanel = document.getElementById("training-panel");
const closeTrainingPanelButton = document.getElementById("close-training-panel");
const gestureNameInput = document.getElementById("gesture-name-input");
const recordSamplesButton = document.getElementById("record-samples-button");
const cancelRecordingButton = document.getElementById("cancel-recording-button");
const vocabularyList = document.getElementById("vocabulary-list");
const sensitivitySlider = document.getElementById("sensitivity-slider");
const sensitivityValueReadout = document.getElementById("sensitivity-value-readout");

openTrainingPanelButton.addEventListener("click", () => {
  trainingPanel.classList.add("open");
});

closeTrainingPanelButton.addEventListener("click", () => {
  trainingPanel.classList.remove("open");
});

document.querySelectorAll(".chip-button").forEach((button) => {
  button.addEventListener("click", () => {
    gestureNameInput.value = button.dataset.word;
  });
});

// ---------------- Almacenamiento persistente (IndexedDB) ----------------

const DB_NAME = "openhands-db";
const DB_VERSION = 1;
const VOCAB_STORE = "vocabulary";
const THUMBNAIL_STORE = "thumbnails";

let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("Este navegador no soporta IndexedDB."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VOCAB_STORE)) {
        db.createObjectStore(VOCAB_STORE, { keyPath: "name" });
      }
      if (!db.objectStoreNames.contains(THUMBNAIL_STORE)) {
        db.createObjectStore(THUMBNAIL_STORE, { keyPath: "name" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function dbGetAllVocabulary() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VOCAB_STORE, "readonly");
    const request = tx.objectStore(VOCAB_STORE).getAll();
    request.onsuccess = () => {
      const result = {};
      for (const record of request.result) {
        result[record.name] = record.samples;
      }
      resolve(result);
    };
    request.onerror = () => reject(request.error);
  });
}

async function dbPutGesture(name, samples) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VOCAB_STORE, "readwrite");
    tx.objectStore(VOCAB_STORE).put({ name, samples });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDeleteGesture(name) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VOCAB_STORE, "readwrite");
    tx.objectStore(VOCAB_STORE).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAllThumbnails() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(THUMBNAIL_STORE, "readonly");
    const request = tx.objectStore(THUMBNAIL_STORE).getAll();
    request.onsuccess = () => {
      const result = {};
      for (const record of request.result) {
        result[record.name] = record.dataUrl;
      }
      resolve(result);
    };
    request.onerror = () => reject(request.error);
  });
}

async function dbPutThumbnail(name, dataUrl) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(THUMBNAIL_STORE, "readwrite");
    tx.objectStore(THUMBNAIL_STORE).put({ name, dataUrl });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDeleteThumbnail(name) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(THUMBNAIL_STORE, "readwrite");
    tx.objectStore(THUMBNAIL_STORE).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let vocabulary = {};
let thumbnails = {};

function migrateHandBlockToCurrentFormat(handBlock) {
  if (handBlock.length === HAND_VECTOR_LENGTH) return handBlock;
  if (handBlock.length === HAND_VECTOR_LENGTH_V2) {
    return [...handBlock, 0, 0];
  }
  if (handBlock.length === HAND_VECTOR_LENGTH_V1) {
    const withCurl = [...handBlock, ...computeCurlFeatures(handBlock)];
    return [...withCurl, 0, 0];
  }
  return handBlock;
}

function migrateSampleToCurrentFormat(sample) {
  if (sample.length === HAND_VECTOR_LENGTH || sample.length === TWO_HAND_VECTOR_LENGTH) {
    return sample;
  }

  if (sample.length === HAND_VECTOR_LENGTH_V1 || sample.length === HAND_VECTOR_LENGTH_V2) {
    return migrateHandBlockToCurrentFormat(sample);
  }

  if (sample.length === TWO_HAND_VECTOR_LENGTH_V1) {
    const handA = sample.slice(0, HAND_VECTOR_LENGTH_V1);
    const handB = sample.slice(HAND_VECTOR_LENGTH_V1, HAND_VECTOR_LENGTH_V1 * 2);
    const relPos = sample.slice(HAND_VECTOR_LENGTH_V1 * 2);
    return [...migrateHandBlockToCurrentFormat(handA), ...migrateHandBlockToCurrentFormat(handB), ...relPos];
  }

  if (sample.length === TWO_HAND_VECTOR_LENGTH_V2) {
    const handA = sample.slice(0, HAND_VECTOR_LENGTH_V2);
    const handB = sample.slice(HAND_VECTOR_LENGTH_V2, HAND_VECTOR_LENGTH_V2 * 2);
    const relPos = sample.slice(HAND_VECTOR_LENGTH_V2 * 2);
    return [...migrateHandBlockToCurrentFormat(handA), ...migrateHandBlockToCurrentFormat(handB), ...relPos];
  }

  return sample;
}

async function migrateVocabularyIfNeeded() {
  const namesToSave = [];

  for (const [name, samples] of Object.entries(vocabulary)) {
    let changed = false;
    const migrated = samples.map((sample) => {
      const upgraded = migrateSampleToCurrentFormat(sample);
      if (upgraded !== sample) changed = true;
      return upgraded;
    });
    if (changed) {
      vocabulary[name] = migrated;
      namesToSave.push(name);
    }
  }

  if (namesToSave.length > 0) {
    await Promise.all(namesToSave.map((name) => dbPutGesture(name, vocabulary[name])));
    console.log(`Vocabulario actualizado automáticamente al formato actual para ${namesToSave.length} seña(s).`);
  }
}

async function initializeVocabularyFromDatabase() {
  try {
    const [loadedVocabulary, loadedThumbnails] = await Promise.all([
      dbGetAllVocabulary(),
      dbGetAllThumbnails(),
    ]);
    vocabulary = loadedVocabulary;
    thumbnails = loadedThumbnails;
    await migrateVocabularyIfNeeded();
  } catch (error) {
    console.error("No se pudo cargar el vocabulario guardado:", error);
  }
  renderVocabularyList();
}

function captureThumbnail() {
  const THUMB_WIDTH = 120;
  const THUMB_HEIGHT = 90;
  const offscreen = document.createElement("canvas");
  offscreen.width = THUMB_WIDTH;
  offscreen.height = THUMB_HEIGHT;
  const ctx = offscreen.getContext("2d");
  ctx.translate(THUMB_WIDTH, 0);
  ctx.scale(-1, 1);
  try {
    ctx.drawImage(cameraPreview, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    return offscreen.toDataURL("image/jpeg", 0.6);
  } catch (error) {
    return null;
  }
}

const MAX_SAMPLES_PER_GESTURE = 700;

function addSamplesToVocabulary(name, samples) {
  if (!vocabulary[name]) {
    vocabulary[name] = [];
  }
  vocabulary[name].push(...samples);

  if (vocabulary[name].length > MAX_SAMPLES_PER_GESTURE) {
    vocabulary[name] = vocabulary[name].slice(-MAX_SAMPLES_PER_GESTURE);
  }

  dbPutGesture(name, vocabulary[name]).catch((error) => {
    console.error("No se pudo guardar la seña en la base de datos:", error);
  });
}

function deleteGesture(name) {
  delete vocabulary[name];
  delete thumbnails[name];
  dbDeleteGesture(name).catch((error) => console.error("No se pudo borrar la seña:", error));
  dbDeleteThumbnail(name).catch((error) => console.error("No se pudo borrar la miniatura:", error));
  renderVocabularyList();
}

function renderVocabularyList() {
  vocabularyList.innerHTML = "";
  const names = Object.keys(vocabulary).sort();

  if (names.length === 0) {
    vocabularyList.innerHTML = '<p class="vocab-empty">Todavía no hay señas entrenadas.</p>';
    return;
  }

  for (const name of names) {
    const count = vocabulary[name].length;
    const thumbnailSrc = thumbnails[name];
    const row = document.createElement("div");
    row.className = "vocab-row";
    row.innerHTML = `
      ${
        thumbnailSrc
          ? `<img class="vocab-thumbnail" src="${thumbnailSrc}" alt="${name}" />`
          : `<span class="vocab-thumbnail vocab-thumbnail-empty"></span>`
      }
      <span class="vocab-name">${name}</span>
      <span class="vocab-count">${count} muestras</span>
      <button class="vocab-delete" data-name="${name}">eliminar</button>
    `;
    vocabularyList.appendChild(row);
  }

  vocabularyList.querySelectorAll(".vocab-delete").forEach((button) => {
    button.addEventListener("click", () => deleteGesture(button.dataset.name));
  });
}

// ---- Exportar / importar vocabulario (manual) ----

const exportVocabButton = document.getElementById("export-vocab-button");
const importVocabButton = document.getElementById("import-vocab-button");
const importVocabFileInput = document.getElementById("import-vocab-file");

exportVocabButton.addEventListener("click", () => {
  if (Object.keys(vocabulary).length === 0) {
    alert("No hay ningún vocabulario entrenado todavía para exportar.");
    return;
  }

  const blob = new Blob([JSON.stringify(vocabulary, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "openhands-vocabulario.json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
});

importVocabButton.addEventListener("click", () => {
  importVocabFileInput.click();
});

importVocabFileInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const imported = JSON.parse(reader.result);
      let addedGestures = 0;
      let addedSamples = 0;
      const touchedNames = [];

      for (const [name, samples] of Object.entries(imported)) {
        if (!Array.isArray(samples)) continue;
        if (!vocabulary[name]) {
          vocabulary[name] = [];
          addedGestures++;
        }
        const migratedSamples = samples.map(migrateSampleToCurrentFormat);
        vocabulary[name].push(...migratedSamples);
        if (vocabulary[name].length > MAX_SAMPLES_PER_GESTURE) {
          vocabulary[name] = vocabulary[name].slice(-MAX_SAMPLES_PER_GESTURE);
        }
        addedSamples += samples.length;
        touchedNames.push(name);
      }

      await Promise.all(touchedNames.map((name) => dbPutGesture(name, vocabulary[name])));

      renderVocabularyList();
      alert(
        `Vocabulario importado: ${addedSamples} muestras añadidas ` +
        `(${addedGestures} seña(s) nueva(s), el resto se sumó a señas existentes).`
      );
    } catch (error) {
      console.error("No se pudo importar el archivo:", error);
      alert("El archivo no tiene un formato válido.");
    }
  };
  reader.readAsText(file);
  importVocabFileInput.value = "";
});

// ---- Cargar señas oficiales (bundle incluido en el proyecto — visible para todos) ----

const importOfficialVocabButton = document.getElementById("import-official-vocab-button");

importOfficialVocabButton.addEventListener("click", async () => {
  try {
    const response = await fetch("default-vocabulary.json");
    if (!response.ok) {
      throw new Error("No se encontró el archivo de señas oficiales.");
    }

    const imported = await response.json();
    let addedGestures = 0;
    let addedSamples = 0;
    const touchedNames = [];

    for (const [name, samples] of Object.entries(imported)) {
      if (!Array.isArray(samples)) continue;
      if (!vocabulary[name]) {
        vocabulary[name] = [];
        addedGestures++;
      }
      const migratedSamples = samples.map(migrateSampleToCurrentFormat);
      vocabulary[name].push(...migratedSamples);
      if (vocabulary[name].length > MAX_SAMPLES_PER_GESTURE) {
        vocabulary[name] = vocabulary[name].slice(-MAX_SAMPLES_PER_GESTURE);
      }
      addedSamples += samples.length;
      touchedNames.push(name);
    }

    await Promise.all(touchedNames.map((name) => dbPutGesture(name, vocabulary[name])));

    renderVocabularyList();

    if (addedSamples === 0) {
      alert("El archivo de señas oficiales está vacío por ahora.");
    } else {
      alert(
        `Señas oficiales cargadas: ${addedSamples} muestras ` +
        `(${addedGestures} seña(s) nueva(s)).`
      );
    }
  } catch (error) {
    console.error("No se pudo cargar el vocabulario oficial:", error);
    alert("No se pudo cargar el vocabulario oficial. Puede que el archivo no exista todavía.");
  }
});

// ---- Guardar directamente como default-vocabulary.json (flujo de desarrollador) ----

const saveOfficialVocabButton = document.getElementById("save-official-vocab-button");

saveOfficialVocabButton.addEventListener("click", () => {
  if (Object.keys(vocabulary).length === 0) {
    alert("No hay ningún vocabulario entrenado todavía para guardar.");
    return;
  }

  const jsonText = JSON.stringify(vocabulary, null, 2);

  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "default-vocabulary.json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  alert(
    "Se descargó a tu carpeta de Descargas como default-vocabulary.json. " +
    "Muévelo a la carpeta del proyecto y luego en la terminal ejecuta:\n\n" +
    "git add .\ngit commit -m \"Actualizar vocabulario\"\ngit push"
  );
});

// ---- Sensibilidad de reconocimiento ----

const MIN_THRESHOLD = 0.08;
const MAX_THRESHOLD = 0.7;
const SENSITIVITY_STORAGE_KEY = "openhands-sensitivity";

function loadSensitivity() {
  const raw = localStorage.getItem(SENSITIVITY_STORAGE_KEY);
  return raw !== null ? Number(raw) : 50;
}

function getCurrentThreshold() {
  const value = Number(sensitivitySlider.value);
  return MIN_THRESHOLD + (value / 100) * (MAX_THRESHOLD - MIN_THRESHOLD);
}

function updateSensitivityReadout() {
  sensitivityValueReadout.textContent = `Umbral actual: ${getCurrentThreshold().toFixed(2)}`;
}

sensitivitySlider.value = loadSensitivity();
updateSensitivityReadout();
sensitivitySlider.addEventListener("input", () => {
  localStorage.setItem(SENSITIVITY_STORAGE_KEY, sensitivitySlider.value);
  updateSensitivityReadout();
});

// ---- Captura de muestras ----
// 90 en vez de 60: a ~30 fps, 60 muestras equivalen a unos 2 segundos, muy
// justo para capturar un vaivén completo en señas con movimiento (como
// "mover la mano de lado a lado"). 90 da más margen sin alargar demasiado
// la grabación.
const SAMPLES_PER_RECORDING = 90;
const MIN_CONSISTENT_SAMPLES = 3;

// Umbral de "¿esta toma tuvo movimiento real?", en la escala normalizada
// [-1, 1] de la velocidad guardada en el vector (ver VELOCITY_NORMALIZATION_SCALE
// más arriba). Y umbral de "¿este fotograma en particular está casi
// quieto?", usado para recortar el arranque/frenado de una toma con
// movimiento (ver finishRecordingSamples). Si notas que una seña con
// movimiento se sigue confundiendo con una quieta, prueba bajando el
// primero; si notas que se recorta demasiado de una seña con movimiento
// lento, baja el segundo.
const DYNAMIC_RECORDING_THRESHOLD = 0.12;
const LOW_VELOCITY_TRIM_CUTOFF = 0.05;

function getVelocityMagnitude(sample) {
  if (sample.length === HAND_VECTOR_LENGTH) {
    const vx = sample[HAND_VECTOR_LENGTH - 2];
    const vy = sample[HAND_VECTOR_LENGTH - 1];
    return Math.sqrt(vx * vx + vy * vy);
  }
  if (sample.length === TWO_HAND_VECTOR_LENGTH) {
    const vxA = sample[HAND_VECTOR_LENGTH - 2];
    const vyA = sample[HAND_VECTOR_LENGTH - 1];
    const vxB = sample[HAND_VECTOR_LENGTH * 2 - 2];
    const vyB = sample[HAND_VECTOR_LENGTH * 2 - 1];
    return Math.max(Math.sqrt(vxA * vxA + vyA * vyA), Math.sqrt(vxB * vxB + vyB * vyB));
  }
  return 0;
}
const RECORDING_TIMEOUT_MS = 12000;

let isRecording = false;
let captureBuffer = [];
let currentGestureName = "";
let lastNormalizedVector = null;
let recordingTimeoutId = null;
let recordingHandCountLog = [];

recordSamplesButton.innerHTML = `<span class="record-dot"></span> Grabar ${SAMPLES_PER_RECORDING} muestras`;

function startRecordingSamples() {
  const name = gestureNameInput.value.trim().toUpperCase();
  if (!name) {
    alert("Escribe el nombre de la seña primero.");
    return;
  }
  currentGestureName = name;
  captureBuffer = [];
  recordingHandCountLog = [];

  // Reinicia la "línea base" de velocidad de las manos ya activas (sin
  // perder su identidad/pista). Si no se hace esto, el primer fotograma
  // capturado puede traer una velocidad falsa heredada del movimiento de
  // acomodar la mano justo antes de presionar "Grabar".
  for (const track of handTracks) {
    if (track.active) {
      track.lastUpdateTimestamp = null;
      track.velocity = { vx: 0, vy: 0 };
    }
  }

  isRecording = true;
  recordSamplesButton.disabled = true;
  cancelRecordingButton.style.display = "";

  clearTimeout(recordingTimeoutId);
  recordingTimeoutId = setTimeout(() => {
    if (isRecording) {
      abortRecording("Se agotó el tiempo (12 segundos) sin completar la grabación.");
    }
  }, RECORDING_TIMEOUT_MS);
}

function describeHandCountLog() {
  const tally = {};
  for (const count of recordingHandCountLog) {
    const key = count === null ? "sin mano" : `${count} mano(s)`;
    tally[key] = (tally[key] || 0) + 1;
  }
  return Object.entries(tally)
    .map(([label, n]) => `${label}: ${n}`)
    .join(", ");
}

function abortRecording(reasonMessage) {
  isRecording = false;
  clearTimeout(recordingTimeoutId);
  recordSamplesButton.disabled = false;
  recordSamplesButton.innerHTML = `<span class="record-dot"></span> Grabar ${SAMPLES_PER_RECORDING} muestras`;
  cancelRecordingButton.style.display = "none";

  const detail = describeHandCountLog();
  alert(
    `${reasonMessage}\n\n` +
    `Se capturaron ${captureBuffer.length} fotogramas antes de detenerse.\n` +
    (detail ? `Detalle de lo detectado: ${detail}.\n\n` : "\n") +
    "Intenta de nuevo con mejor luz y mostrando bien la(s) mano(s), sin que se toquen entre sí."
  );

  captureBuffer = [];
}

cancelRecordingButton.addEventListener("click", () => {
  abortRecording("Grabación cancelada manualmente.");
});

function getSampleHandCount(sample) {
  if (sample.length === HAND_VECTOR_LENGTH) return 1;
  if (sample.length === TWO_HAND_VECTOR_LENGTH) return 2;
  return null;
}

function finishRecordingSamples(success) {
  isRecording = false;
  clearTimeout(recordingTimeoutId);
  recordSamplesButton.disabled = false;
  recordSamplesButton.innerHTML = `<span class="record-dot"></span> Grabar ${SAMPLES_PER_RECORDING} muestras`;
  cancelRecordingButton.style.display = "none";

  if (!success || captureBuffer.length === 0) {
    alert("No se detectó la mano lo suficiente. Intenta de nuevo mostrando bien la mano.");
    captureBuffer = [];
    return;
  }

  const countTally = {};
  for (const sample of captureBuffer) {
    const count = getSampleHandCount(sample);
    countTally[count] = (countTally[count] || 0) + 1;
  }
  let majorityCount = null;
  let majorityVotes = -1;
  for (const [count, votes] of Object.entries(countTally)) {
    if (votes > majorityVotes) {
      majorityVotes = votes;
      majorityCount = Number(count);
    }
  }

  const consistentSamples = captureBuffer.filter(
    (sample) => getSampleHandCount(sample) === majorityCount
  );
  const totalCaptured = captureBuffer.length;
  captureBuffer = [];

  if (consistentSamples.length < MIN_CONSISTENT_SAMPLES) {
    alert(
      `Solo se lograron ${consistentSamples.length} muestras consistentes de ` +
      `${totalCaptured} capturadas (se necesitan al menos ${MIN_CONSISTENT_SAMPLES}). ` +
      "Intenta de nuevo separando un poco más las manos entre sí, sin que se toquen " +
      "ni se tapen, y mostrando bien ambas a la cámara."
    );
    return;
  }

  // ---- Recortar arranque/frenado casi quietos en señas con movimiento ----
  const movementValues = consistentSamples.map(getVelocityMagnitude);
  const avgMovement = movementValues.reduce((a, b) => a + b, 0) / movementValues.length;
  const isDynamicRecording = avgMovement >= DYNAMIC_RECORDING_THRESHOLD;

  let samplesToStore = consistentSamples;
  if (isDynamicRecording) {
    let start = 0;
    while (start < movementValues.length && movementValues[start] < LOW_VELOCITY_TRIM_CUTOFF) start++;
    let end = movementValues.length - 1;
    while (end > start && movementValues[end] < LOW_VELOCITY_TRIM_CUTOFF) end--;
    const trimmed = consistentSamples.slice(start, end + 1);
    if (trimmed.length >= MIN_CONSISTENT_SAMPLES) {
      samplesToStore = trimmed;
    }
  }

  const expandedBuffer = [];
  for (const sample of samplesToStore) {
    expandedBuffer.push(sample, ...augmentSample(sample));
  }

  addSamplesToVocabulary(currentGestureName, expandedBuffer);

  if (isDynamicRecording && samplesToStore.length < consistentSamples.length) {
    console.log(
      `"${currentGestureName}": seña con movimiento — se recortaron ` +
      `${consistentSamples.length - samplesToStore.length} fotogramas casi quietos ` +
      `de inicio/final (quedaron ${samplesToStore.length} de ${consistentSamples.length}).`
    );
  }

  const thumbnail = captureThumbnail();
  if (thumbnail) {
    thumbnails[currentGestureName] = thumbnail;
    dbPutThumbnail(currentGestureName, thumbnail).catch((error) => {
      console.error("No se pudo guardar la miniatura:", error);
    });
  }

  renderVocabularyList();

  if (consistentSamples.length < totalCaptured) {
    const discarded = totalCaptured - consistentSamples.length;
    console.warn(
      `${discarded} de ${totalCaptured} fotogramas se descartaron por no coincidir ` +
      `con el conteo de manos mayoritario (${majorityCount}).`
    );
  }
}

recordSamplesButton.addEventListener("click", () => {
  if (!isRecording) {
    startRecordingSamples();
  }
});

function captureSampleIfRecording() {
  if (!isRecording) return;

  if (!lastNormalizedVector) {
    recordingHandCountLog.push(null);
    return;
  }

  const handCount = getSampleHandCount(lastNormalizedVector);
  recordingHandCountLog.push(handCount);

  captureBuffer.push(lastNormalizedVector);
  recordSamplesButton.textContent = `Grabando... ${captureBuffer.length}/${SAMPLES_PER_RECORDING}`;

  if (captureBuffer.length >= SAMPLES_PER_RECORDING) {
    finishRecordingSamples(true);
  }
}

// ---------------- Reconocimiento por vecino más cercano (k-NN) ----------------

const recognizedWordsContainer = document.getElementById("recognized-words");
const recognitionStatus = document.getElementById("recognition-status");
const backspaceButton = document.getElementById("backspace-button");
const clearPhraseButton = document.getElementById("clear-phrase-button");
const resetAllButton = document.getElementById("reset-all-button");
const sendToListenerButton = document.getElementById("send-to-listener-button");
const signerSpeechText = document.getElementById("signer-speech-text");
const readAloudButton = document.getElementById("read-aloud-button");

const DEFAULT_SIGNER_SPEECH_TEXT =
  "Lo que la persona sorda firme y envíe aparecerá aquí como texto (y se puede leer en voz alta).";
const DEFAULT_LISTENER_SPEECH_TEXT = "Aquí aparecerá, en grande, lo que diga la persona oyente...";

let phraseWords = [];
let confirmedLabel = null;

const CONFIRM_WINDOW_SIZE = 5;
const CONFIRM_VOTES_NEEDED = 3;
let recentCandidates = [];

// 13 en vez de 9: con más vecinos, una sola muestra ruidosa (típico en
// puños cerrados o dedos muy curvados, donde MediaPipe localiza peor cada
// punto) pesa menos en la votación — se promedia con más ejemplos en vez
// de depender de que el vecino más cercano puntual sea bueno.
const K_NEAREST = 13;

function squaredDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

// Curvatura y velocidad pesan menos que las coordenadas al comparar dos
// vectores de UNA mano. Sin esto, sumar 5 dimensiones de curvatura + 2 de
// velocidad a las 63 de coordenadas infla la distancia total solo por
// tener más dimensiones (no porque la seña sea más distinta), y el umbral
// de sensibilidad (que ya conocías, 0.08-0.7) deja de significar lo mismo.
//
// IMPORTANTE (rendimiento): esto compara directamente sobre los arrays
// completos usando offsets, SIN crear arrays nuevos con .slice(). Con
// muchas señas y muchas muestras, generar 6 arrays nuevos por muestra en
// CADA fotograma sí se nota — es la causa más probable de que vieras la
// cámara lenta.
const CURL_FEATURE_WEIGHT = 0.5;
const VELOCITY_FEATURE_WEIGHT = 0.6;

function weightedSquaredDistanceForHandBlockAt(a, aOffset, b, bOffset) {
  let sum = 0;
  for (let i = 0; i < COORDS_LENGTH; i++) {
    const diff = a[aOffset + i] - b[bOffset + i];
    sum += diff * diff;
  }
  for (let i = COORDS_LENGTH; i < COORDS_LENGTH + CURL_FEATURE_COUNT; i++) {
    const diff = a[aOffset + i] - b[bOffset + i];
    sum += CURL_FEATURE_WEIGHT * diff * diff;
  }
  for (let i = COORDS_LENGTH + CURL_FEATURE_COUNT; i < HAND_VECTOR_LENGTH; i++) {
    const diff = a[aOffset + i] - b[bOffset + i];
    sum += VELOCITY_FEATURE_WEIGHT * diff * diff;
  }
  return sum;
}

function relPosSquaredDistanceAt(a, aOffset, b, bOffset, flipSignA) {
  let sum = 0;
  for (let i = 0; i < RELATIVE_POSITION_LENGTH; i++) {
    const av = flipSignA ? -a[aOffset + i] : a[aOffset + i];
    const diff = av - b[bOffset + i];
    sum += diff * diff;
  }
  return sum;
}

function vectorSquaredDistanceToSample(vector, sample) {
  if (vector.length !== sample.length) return Infinity;

  if (vector.length === TWO_HAND_VECTOR_LENGTH) {
    const relOffset = HAND_VECTOR_LENGTH * 2;

    const direct =
      weightedSquaredDistanceForHandBlockAt(vector, 0, sample, 0) +
      weightedSquaredDistanceForHandBlockAt(vector, HAND_VECTOR_LENGTH, sample, HAND_VECTOR_LENGTH) +
      relPosSquaredDistanceAt(vector, relOffset, sample, relOffset, false);

    const swapped =
      weightedSquaredDistanceForHandBlockAt(vector, HAND_VECTOR_LENGTH, sample, 0) +
      weightedSquaredDistanceForHandBlockAt(vector, 0, sample, HAND_VECTOR_LENGTH) +
      relPosSquaredDistanceAt(vector, relOffset, sample, relOffset, true);

    return Math.min(direct, swapped) / 2;
  }

  if (vector.length === HAND_VECTOR_LENGTH) {
    return weightedSquaredDistanceForHandBlockAt(vector, 0, sample, 0);
  }

  return squaredDistance(vector, sample);
}

// Cuánto "empujón" recibe, en el voto ponderado, la palabra que YA estaba
// confirmada frente a las demás. Sin esto, cuando dos señas quedan cerca
// en el espacio de características (como HOLA/GRACIAS en tu prueba), un
// empate técnico de un frame a otro — puro ruido — hace que el ganador
// cambie constantemente, y eso es justo lo que se ve como "se confunde y
// tira ambas a lo loco". Con este empujón, la palabra confirmada sigue
// ganando los empates cerrados; solo la reemplaza otra seña si es
// CLARAMENTE mejor, no por casualidad de un frame.
const STICKY_LABEL_BONUS = 1.2;

function classifyVector(vector, stickyLabel) {
  const nearest = [];

  for (const [name, samples] of Object.entries(vocabulary)) {
    for (const sample of samples) {
      const sqDistance = vectorSquaredDistanceToSample(vector, sample);

      if (nearest.length < K_NEAREST) {
        nearest.push({ name, sqDistance });
        nearest.sort((a, b) => a.sqDistance - b.sqDistance);
      } else if (sqDistance < nearest[nearest.length - 1].sqDistance) {
        nearest[nearest.length - 1] = { name, sqDistance };
        nearest.sort((a, b) => a.sqDistance - b.sqDistance);
      }
    }
  }

  if (nearest.length === 0) {
    return { name: null, distance: Infinity };
  }

  const votes = {};
  for (const neighbor of nearest) {
    const distance = Math.sqrt(neighbor.sqDistance);
    const weight = 1 / (distance + 1e-6);
    votes[neighbor.name] = (votes[neighbor.name] || 0) + weight;
  }

  if (stickyLabel && votes[stickyLabel] !== undefined) {
    votes[stickyLabel] *= STICKY_LABEL_BONUS;
  }

  let bestName = null;
  let bestVote = -Infinity;
  for (const [name, vote] of Object.entries(votes)) {
    if (vote > bestVote) {
      bestVote = vote;
      bestName = name;
    }
  }

  const bestNeighbor = nearest.find((n) => n.name === bestName);
  const bestNeighborDistance = Math.sqrt(bestNeighbor.sqDistance);

  return { name: bestName, distance: bestNeighborDistance };
}

function confirmWord(word) {
  phraseWords.push(word);
  renderPhrase();
}

function renderPhrase() {
  recognizedWordsContainer.innerHTML = "";
  for (const word of phraseWords) {
    const bubble = document.createElement("span");
    bubble.className = "word-bubble";
    bubble.textContent = word;
    recognizedWordsContainer.appendChild(bubble);
  }
}

const CONFIDENCE_REFERENCE_DISTANCE = 0.6;

function updateRecognitionStatus(candidate, distance, threshold) {
  const totalGestures = Object.keys(vocabulary).length;

  if (totalGestures === 0) {
    recognitionStatus.textContent = 'Aún no hay señas entrenadas. Usa "📥 Cargar señas" para empezar.';
    return;
  }

  if (distance === null) {
    recognitionStatus.textContent = `Comparando con ${totalGestures} seña(s) conocida(s).`;
    return;
  }

  if (!candidate) {
    recognitionStatus.textContent =
      `Comparando con ${totalGestures} seña(s) — no coincide con ninguna seña conocida ` +
      `(distancia ${distance.toFixed(2)}, umbral ${threshold.toFixed(2)})`;
    return;
  }

  const confidencePercent =
    Math.max(0, Math.min(1, 1 - distance / CONFIDENCE_REFERENCE_DISTANCE)) * 100;
  recognitionStatus.textContent =
    `Comparando con ${totalGestures} seña(s) — coincide con "${candidate}" ` +
    `(confianza ${confidencePercent.toFixed(0)}%, distancia ${distance.toFixed(2)}, umbral ${threshold.toFixed(2)})`;
}

const FAST_CONFIRM_DISTANCE_RATIO = 0.8;
const FAST_CONFIRM_FRAMES = 3;
const FAST_CONFIRM_MAX_TOLERATED_MISSES = 2;
const REPEAT_CONFIRM_COOLDOWN_MS = 1200;
const NEW_WORD_CONFIRM_COOLDOWN_MS = 450;

let fastConfirmCandidate = null;
let fastConfirmStreak = 0;
let fastConfirmMissStreak = 0;
let lastConfirmedAtMs = 0;

const CONFIRMED_LABEL_IDLE_RESET_MS = 2500;

function processRecognition(vector) {
  if (!vector || Object.keys(vocabulary).length === 0) {
    recentCandidates = [];
    confirmedLabel = null;
    fastConfirmCandidate = null;
    fastConfirmStreak = 0;
    fastConfirmMissStreak = 0;
    updateRecognitionStatus(null, null, null);
    return;
  }

  const nowMs = performance.now();
  if (confirmedLabel && nowMs - lastConfirmedAtMs > CONFIRMED_LABEL_IDLE_RESET_MS) {
    confirmedLabel = null;
  }

  const { name, distance } = classifyVector(vector, confirmedLabel);
  const threshold = getCurrentThreshold();
  const candidate = name && distance <= threshold ? name : null;

  if (candidate && distance <= threshold * FAST_CONFIRM_DISTANCE_RATIO) {
    fastConfirmMissStreak = 0;
    if (candidate === fastConfirmCandidate) {
      fastConfirmStreak++;
    } else {
      fastConfirmCandidate = candidate;
      fastConfirmStreak = 1;
    }
    const isNewCandidate = confirmedLabel !== candidate;
    const requiredCooldown = isNewCandidate ? NEW_WORD_CONFIRM_COOLDOWN_MS : REPEAT_CONFIRM_COOLDOWN_MS;
    const cooldownElapsed = nowMs - lastConfirmedAtMs >= requiredCooldown;
    if (fastConfirmStreak >= FAST_CONFIRM_FRAMES && cooldownElapsed) {
      confirmWord(candidate);
      confirmedLabel = candidate;
      lastConfirmedAtMs = nowMs;
    }
  } else if (fastConfirmCandidate) {
    fastConfirmMissStreak++;
    if (fastConfirmMissStreak > FAST_CONFIRM_MAX_TOLERATED_MISSES) {
      fastConfirmCandidate = null;
      fastConfirmStreak = 0;
      fastConfirmMissStreak = 0;
    }
  }

  recentCandidates.push(candidate);
  if (recentCandidates.length > CONFIRM_WINDOW_SIZE) {
    recentCandidates.shift();
  }

  const windowVotes = {};
  for (const c of recentCandidates) {
    if (!c) continue;
    windowVotes[c] = (windowVotes[c] || 0) + 1;
  }

  let windowWinner = null;
  let windowWinnerVotes = 0;
  for (const [name2, count] of Object.entries(windowVotes)) {
    if (count > windowWinnerVotes) {
      windowWinnerVotes = count;
      windowWinner = name2;
    }
  }

  if (windowWinner && windowWinnerVotes >= CONFIRM_VOTES_NEEDED) {
    const isNewWindowCandidate = confirmedLabel !== windowWinner;
    const requiredCooldown = isNewWindowCandidate ? NEW_WORD_CONFIRM_COOLDOWN_MS : REPEAT_CONFIRM_COOLDOWN_MS;
    const cooldownElapsed = nowMs - lastConfirmedAtMs >= requiredCooldown;
    if (cooldownElapsed) {
      confirmWord(windowWinner);
      confirmedLabel = windowWinner;
      lastConfirmedAtMs = nowMs;
    }
  }

  updateRecognitionStatus(candidate, distance, threshold);
}

// ---------------- Texto a voz (voces mejoradas) ----------------

function pickSpanishVoice() {
  const voices = window.speechSynthesis.getVoices();

  const priorityMatchers = [
    (v) => /natural/i.test(v.name) && v.lang.toLowerCase().startsWith("es"),
    (v) => /online/i.test(v.name) && v.lang.toLowerCase().startsWith("es"),
    (v) => /neural/i.test(v.name) && v.lang.toLowerCase().startsWith("es"),
    (v) => /google/i.test(v.name) && v.lang.toLowerCase().startsWith("es"),
    (v) => v.lang.toLowerCase().startsWith("es-co"),
    (v) => v.lang.toLowerCase().startsWith("es"),
  ];

  for (const matcher of priorityMatchers) {
    const found = voices.find(matcher);
    if (found) return found;
  }
  return null;
}

if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    window.speechSynthesis.getVoices();
  };
}

function speakText(text) {
  if (!("speechSynthesis" in window)) {
    console.warn("Este navegador no soporta lectura de voz (Web Speech API).");
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  const spanishVoice = pickSpanishVoice();
  if (spanishVoice) {
    utterance.voice = spanishVoice;
    utterance.lang = spanishVoice.lang;
  } else {
    utterance.lang = "es-ES";
  }
  utterance.rate = 1.0;

  window.speechSynthesis.speak(utterance);
}

readAloudButton.addEventListener("click", () => {
  const text = signerSpeechText.textContent.trim();
  if (!text || text === DEFAULT_SIGNER_SPEECH_TEXT) return;
  speakText(text);
});

// ---------------- Controles de frase ----------------

backspaceButton.addEventListener("click", () => {
  phraseWords.pop();
  renderPhrase();
});

clearPhraseButton.addEventListener("click", () => {
  phraseWords = [];
  renderPhrase();
});

resetAllButton.addEventListener("click", () => {
  window.speechSynthesis.cancel();
  phraseWords = [];
  renderPhrase();
  signerSpeechText.textContent = DEFAULT_SIGNER_SPEECH_TEXT;
  listenerSpeechText.textContent = DEFAULT_LISTENER_SPEECH_TEXT;
});

sendToListenerButton.addEventListener("click", () => {
  if (phraseWords.length === 0) return;
  const text = phraseWords.join(" ");
  signerSpeechText.textContent = text;
  phraseWords = [];
  renderPhrase();
  speakText(text);
  sendCallData({ type: "sign_phrase", text });
});

// ---------------- Videollamadas (PeerJS) ----------------

const callPanel = document.getElementById("call-panel");
const openCallPanelButton = document.getElementById("open-call-panel");
const closeCallPanelButton = document.getElementById("close-call-panel");
const myPeerIdInput = document.getElementById("my-peer-id");
const copyMyIdButton = document.getElementById("copy-my-id-button");
const remotePeerIdInput = document.getElementById("remote-peer-id-input");
const callButton = document.getElementById("call-button");
const hangUpButton = document.getElementById("hang-up-button");
const callStatus = document.getElementById("call-status");
const remoteVideoBox = document.getElementById("remote-video-box");
const remoteVideoPreview = document.getElementById("remote-video-preview");

let isDraggingRemoteVideo = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

remoteVideoBox.addEventListener("pointerdown", (event) => {
  isDraggingRemoteVideo = true;
  remoteVideoBox.classList.add("dragging");

  const rect = remoteVideoBox.getBoundingClientRect();
  dragOffsetX = event.clientX - rect.left;
  dragOffsetY = event.clientY - rect.top;

  remoteVideoBox.style.left = `${rect.left}px`;
  remoteVideoBox.style.top = `${rect.top}px`;
  remoteVideoBox.style.right = "auto";
  remoteVideoBox.style.bottom = "auto";

  remoteVideoBox.setPointerCapture(event.pointerId);
});

remoteVideoBox.addEventListener("pointermove", (event) => {
  if (!isDraggingRemoteVideo) return;

  const newLeft = event.clientX - dragOffsetX;
  const newTop = event.clientY - dragOffsetY;

  const maxLeft = window.innerWidth - remoteVideoBox.offsetWidth;
  const maxTop = window.innerHeight - remoteVideoBox.offsetHeight;

  remoteVideoBox.style.left = `${Math.min(Math.max(0, newLeft), maxLeft)}px`;
  remoteVideoBox.style.top = `${Math.min(Math.max(0, newTop), maxTop)}px`;
});

function stopDraggingRemoteVideo() {
  isDraggingRemoteVideo = false;
  remoteVideoBox.classList.remove("dragging");
}

remoteVideoBox.addEventListener("pointerup", stopDraggingRemoteVideo);
remoteVideoBox.addEventListener("pointercancel", stopDraggingRemoteVideo);

// Toca el recuadro del video remoto para activar el audio si el navegador
// lo dejó silenciado por la política de autoplay (ver attachCallHandlers).
// Un clic/toque cuenta como interacción directa del usuario, así que aquí
// sí se puede desmutear sin que el navegador lo bloquee.
remoteVideoBox.addEventListener("click", () => {
  if (remoteVideoPreview.muted) {
    remoteVideoPreview.muted = false;
    remoteVideoPreview.play().catch((error) => {
      console.warn("No se pudo activar el audio del video remoto:", error);
    });
    if (callStatus.textContent.includes("activar el audio")) {
      callStatus.textContent = "Llamada en curso.";
    }
  }
});

let peer = null;
let currentCall = null;
let dataConnection = null;
let callMediaStream = null;

openCallPanelButton.addEventListener("click", () => callPanel.classList.add("open"));
closeCallPanelButton.addEventListener("click", () => callPanel.classList.remove("open"));

copyMyIdButton.addEventListener("click", () => {
  navigator.clipboard.writeText(myPeerIdInput.value).then(() => {
    callStatus.textContent = "Código copiado al portapapeles.";
  });
});

function initPeer() {
  if (typeof Peer === "undefined") {
    callStatus.textContent = "No se pudo cargar el sistema de videollamadas.";
    return;
  }

  // Se añaden varios servidores STUN públicos, además del que trae PeerJS
  // por defecto, para mejorar las probabilidades de conectar cuando alguna
  // de las dos redes tiene un NAT más restrictivo (redes móviles, wifi de
  // oficina, etc.). Si la llamada sigue sin conectar en redes muy
  // restrictivas, el siguiente paso sería agregar un servidor TURN (ya no
  // es solo STUN), pero eso normalmente requiere un servicio de pago o
  // propio.
  peer = new Peer(undefined, {
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        { urls: "stun:stun4.l.google.com:19302" },
      ],
    },
  });

  peer.on("open", (id) => {
    myPeerIdInput.value = id;
  });

  peer.on("call", (call) => {
    getCallMediaStream().then((stream) => {
      call.answer(stream);
      attachCallHandlers(call);
    });
  });

  peer.on("connection", (conn) => {
    setupDataConnection(conn);
  });

  peer.on("error", (error) => {
    console.error("Error de PeerJS:", error);
    callStatus.textContent = `Error de conexión: ${error.type || error.message}`;
    endCall();
  });
}

async function getCallMediaStream() {
  if (callMediaStream) return callMediaStream;

  // Si la cámara de señas ya está activa, reutilizamos su video (clonando
  // la pista, así no interferimos con la vista de señas) en vez de
  // pedirle al navegador una SEGUNDA captura de la misma cámara física.
  // Muchas webcams (sobre todo de laptop) no soportan dos capturas
  // simultáneas del mismo dispositivo, así que pedir video de nuevo aquí
  // podía hacer fallar la llamada o "robarle" la cámara a la vista de
  // señas.
  if (cameraStream) {
    const videoTrack = cameraStream.getVideoTracks()[0];
    if (videoTrack) {
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        callMediaStream = new MediaStream([videoTrack.clone(), ...audioStream.getAudioTracks()]);
        return callMediaStream;
      } catch (error) {
        console.error("No se pudo obtener el micrófono para la llamada:", error);
        // Sigue con el flujo de respaldo (pedir video+audio nuevos) por si
        // el problema fue solo con esta ruta.
      }
    }
  }

  callMediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  return callMediaStream;
}

function attachCallHandlers(call) {
  currentCall = call;
  call.on("stream", (remoteStream) => {
    remoteVideoPreview.srcObject = remoteStream;
    remoteVideoBox.style.display = "block";
    callStatus.textContent = "Llamada en curso.";
    hangUpButton.style.display = "block";
    callButton.style.display = "none";

    // Algunos navegadores bloquean la reproducción automática de un video
    // que trae sonido si no viene de un clic directo justo en ese instante
    // — algo muy común del lado que RECIBE la llamada, ya que el stream
    // llega de forma asíncrona después de negociar la conexión, no dentro
    // de un evento de clic. Sin este manejo, el video queda con la imagen
    // asignada pero nunca se reproduce (se ve negro) aunque la llamada
    // "esté en curso". Si el navegador lo bloquea, lo reproducimos primero
    // SIN sonido (eso sí lo permite cualquier navegador) y avisamos para
    // que un toque sobre el recuadro active el audio.
    const playPromise = remoteVideoPreview.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((error) => {
        console.warn("Reproducción automática con sonido bloqueada, reintentando silenciado:", error);
        remoteVideoPreview.muted = true;
        remoteVideoPreview.play().catch((mutedError) => {
          console.error("No se pudo reproducir el video remoto ni siquiera silenciado:", mutedError);
        });
        callStatus.textContent = "Llamada en curso (toca el video para activar el audio).";
      });
    }
  });
  call.on("close", endCall);
  call.on("error", (error) => {
    console.error("Error de llamada:", error);
    callStatus.textContent = "Error en la llamada.";
    endCall();
  });
}

function setupDataConnection(conn) {
  dataConnection = conn;
  conn.on("open", () => {
    callStatus.textContent = "Conectado. Compartiendo señas y voz en vivo.";
  });
  conn.on("data", handleIncomingCallData);
  conn.on("close", () => {
    dataConnection = null;
  });
}

function handleIncomingCallData(data) {
  if (!data || !data.type) return;

  if (data.type === "sign_phrase" && data.text) {
    signerSpeechText.textContent = data.text;
    speakText(data.text);
  } else if (data.type === "speech_final" && data.text) {
    listenerSpeechText.textContent = data.text;
  }
}

function sendCallData(message) {
  if (dataConnection && dataConnection.open) {
    dataConnection.send(message);
  }
}

callButton.addEventListener("click", async () => {
  const remoteId = remotePeerIdInput.value.trim();

  if (remoteId.toUpperCase() === DEVELOPER_MODE_CODE) {
    enableDeveloperMode();
    remotePeerIdInput.value = "";
    return;
  }

  if (!remoteId) {
    callStatus.textContent = "Escribe el código de la otra persona primero.";
    return;
  }

  callStatus.textContent = "Llamando…";

  try {
    const stream = await getCallMediaStream();
    const call = peer.call(remoteId, stream);
    attachCallHandlers(call);

    const conn = peer.connect(remoteId);
    setupDataConnection(conn);
  } catch (error) {
    console.error("No se pudo iniciar la llamada:", error);
    callStatus.textContent = "No se pudo iniciar la llamada.";
  }
});

function endCall() {
  if (currentCall) {
    currentCall.close();
    currentCall = null;
  }
  if (dataConnection) {
    dataConnection.close();
    dataConnection = null;
  }
  remoteVideoBox.style.display = "none";
  remoteVideoPreview.srcObject = null;
  hangUpButton.style.display = "none";
  callButton.style.display = "flex";
  callStatus.textContent = "Sin conexión.";
}

hangUpButton.addEventListener("click", endCall);

function closeAllCallResources() {
  if (currentCall) {
    currentCall.close();
    currentCall = null;
  }
  if (dataConnection) {
    dataConnection.close();
    dataConnection = null;
  }
  if (peer) {
    peer.destroy();
  }
}

window.addEventListener("beforeunload", closeAllCallResources);
window.addEventListener("pagehide", closeAllCallResources);

initPeer();

// ---------------- Bucle principal ----------------

// Antes esto era un conteo de frames (15) asumiendo ~60 detecciones/seg.
// Ahora medimos en tiempo real para que el comportamiento sea el mismo sin
// importar TARGET_DETECTION_FPS.
let lastAnyHandTimestamp = 0;
let hasSeenAnyHandEver = false;
const MAX_MISSED_MS = 250; // ~15 frames a 60 FPS, en tiempo real

let recognitionFrameCounter = 0;
// Comparar contra el vocabulario cada 2 detecciones en vez de cada una: es
// la parte más pesada (recorre todas las muestras guardadas).
const RECOGNITION_FRAME_INTERVAL = 2;

function predictLoop() {
  if (cameraStream && handLandmarker && cameraPreview.readyState >= 2) {
    const nowMs = performance.now();

    // Throttle: el trabajo pesado de detección solo corre como máximo
    // TARGET_DETECTION_FPS veces por segundo. El resto de los frames de
    // pantalla no hacen nada costoso — esto es lo que evita que la app se
    // sienta trabada en general (video, botones, todo), no solo el
    // reconocimiento.
    if (nowMs - lastDetectionTimestamp < DETECTION_INTERVAL_MS) {
      requestAnimationFrame(predictLoop);
      return;
    }
    lastDetectionTimestamp = nowMs;

    const rawResults = handLandmarker.detectForVideo(cameraPreview, nowMs);

    const rawLandmarks = rawResults.landmarks || [];
    const rawHandedness = rawResults.handedness || [];
    const keptIndices = [];
    for (let i = 0; i < rawLandmarks.length; i++) {
      const sizeOk = computeHandSizeInFrame(rawLandmarks[i]) >= MIN_HAND_SIZE_THRESHOLD;
      const handednessEntry = rawHandedness[i] && rawHandedness[i][0];
      const handednessOk = handednessEntry && handednessEntry.score >= MIN_HANDEDNESS_SCORE;
      if (sizeOk && handednessOk) {
        keptIndices.push(i);
      }
    }
    const results = {
      landmarks: keptIndices.map((i) => rawLandmarks[i]),
      handedness: keptIndices.map((i) => rawHandedness[i]),
    };

    if (results.landmarks.length > 0) {
      lastAnyHandTimestamp = nowMs;
      hasSeenAnyHandEver = true;

      const assignment = assignHandsToTracks(results.landmarks, results.handedness, nowMs);
      const rawSlotA = assignment[0];
      const rawSlotB = assignment[1];

      // Solo dibujamos/usamos una mano una vez que su pista lleva
      // HAND_CONFIRMATION_FRAMES detecciones seguidas (definido más
      // arriba). Esto evita que un falso positivo de un solo frame en
      // cara/hombros/ángulos raros llegue a mostrarse o reconocerse.
      const slotA = rawSlotA && isTrackConfirmed(rawSlotA.track) ? rawSlotA : null;
      const slotB = rawSlotB && isTrackConfirmed(rawSlotB.track) ? rawSlotB : null;

      const handsToDraw = [];
      if (slotA) handsToDraw.push(slotA.landmarks);
      if (slotB) handsToDraw.push(slotB.landmarks);
      drawHands({ landmarks: handsToDraw });

      if (slotA && slotB) {
        const v0 = buildHandFeatureVector(slotA.landmarks, slotA.track.mirrorSign, slotA.track.velocity);
        const v1 = buildHandFeatureVector(slotB.landmarks, slotB.track.mirrorSign, slotB.track.velocity);
        const relPos = computeRelativeHandPosition(slotA.landmarks, slotB.landmarks, slotA.track.mirrorSign);
        lastNormalizedVector = smoothVector([...v0, ...v1, ...relPos]);
        updateLandmarksInfo(lastNormalizedVector, slotA.track.handednessLabel);
      } else if (slotA || slotB) {
        const only = slotA || slotB;
        lastNormalizedVector = smoothVector(
          buildHandFeatureVector(only.landmarks, only.track.mirrorSign, only.track.velocity)
        );
        updateLandmarksInfo(lastNormalizedVector, only.track.handednessLabel);
      } else {
        lastNormalizedVector = null;
        smoothedVectorState = null;
        updateLandmarksInfo(null, null);
      }
    } else {
      assignHandsToTracks([], [], nowMs);
      drawHands({ landmarks: [] });
      if (hasSeenAnyHandEver && nowMs - lastAnyHandTimestamp > MAX_MISSED_MS) {
        lastNormalizedVector = null;
        smoothedVectorState = null;
        resetHandTracks();
        updateLandmarksInfo(null, null);
      }
    }

    if (!isRecording) {
      recognitionFrameCounter++;
      if (recognitionFrameCounter >= RECOGNITION_FRAME_INTERVAL) {
        recognitionFrameCounter = 0;
        processRecognition(lastNormalizedVector);
      }
    }
    captureSampleIfRecording();
  } else {
    lastNormalizedVector = null;
  }
  requestAnimationFrame(predictLoop);
}

// ---------------- Escribir texto directo (oyente) ----------------

const listenerTypeInput = document.getElementById("listener-type-input");
const listenerTypeSendButton = document.getElementById("listener-type-send-button");

function sendTypedListenerText() {
  const text = listenerTypeInput.value.trim();
  if (!text) return;
  listenerSpeechText.textContent = text;
  sendCallData({ type: "speech_final", text });
  listenerTypeInput.value = "";
}

listenerTypeSendButton.addEventListener("click", sendTypedListenerText);
listenerTypeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    sendTypedListenerText();
  }
});

initializeVocabularyFromDatabase();
initHandLandmarker();