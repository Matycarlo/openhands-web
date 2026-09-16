import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

// =============================================================================
// CAMBIOS DE ESTA VERSIÓN (resumen para ti):
//
// 1) SEGUIMIENTO DE DOS MANOS: antes se ordenaban las manos detectadas cada
//    frame solo por su posición X. Si las manos se cruzaban, o el detector
//    las entregaba en distinto orden interno (algo que MediaPipe puede hacer
//    aunque ninguna mano se haya movido), la mano "A" y la mano "B" cambiaban
//    de identidad de un frame a otro. Eso rompía tanto la normalización de
//    espejo (guardada por índice) como el vector de dos manos, y hacía que
//    el reconocimiento con dos manos fuera errático.
//    Ahora cada mano detectada se asigna a una "pista" (track) persistente,
//    eligiendo en cada frame la asignación que menos desplazamiento implica
//    respecto al frame anterior. Así la identidad de cada mano se mantiene
//    estable aunque se crucen o se muevan rápido.
//
// 2) MODO ESPEJO (normalización de lateralidad): antes se calculaba con un
//    producto triple geométrico (chirality) que es ruidoso cuando la mano
//    está casi de perfil o casi plana respecto a la cámara. Ahora se usa
//    directamente la lateralidad ("Left"/"Right") que ya calcula MediaPipe
//    por cada mano, suavizada con un pequeño voto de mayoría por pista, para
//    evitar parpadeos si un frame suelto se clasifica mal.
//
// 3) RECONOCIMIENTO (confianza baja / tarda en mostrar el resultado): la
//    inestabilidad de los dos puntos anteriores hacía que el vector de
//    landmarks "saltara" de frame a frame, lo que produce distancias mayores
//    (confianza baja) y evita que se acumulen suficientes votos consistentes
//    para confirmar rápido. Se añadió:
//      - un suavizado temporal (EMA) del vector antes de clasificar
//        (se usa igual para grabar muestras y para reconocer en vivo),
//      - un cálculo de confianza independiente del umbral de sensibilidad
//        (antes, si ponías el umbral estricto, hasta una coincidencia buena
//        se veía con confianza baja),
//      - una confirmación "rápida" un poco más permisiva para que las señas
//        claras se muestren casi al instante, sin sacrificar la ventana de
//        votos para las señas más ambiguas.
//
// 4) CONFIRMACIÓN MÁS FÁCIL (este cambio): con una coincidencia clara (como
//    la del ejemplo: distancia 0.22 contra un umbral de 0.70), antes hacían
//    falta 2 fotogramas seguidos dentro del 65% del umbral para agregar la
//    palabra — con el suavizado nuevo eso a veces tardaba en cumplirse y la
//    palabra no aparecía aunque el estado ya mostrara la coincidencia. Ahora
//    basta con 1 solo fotograma claro, y ese rango de "coincidencia clara"
//    es más generoso (80% del umbral en vez de 65%).
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
  missedFrameCount = 0;
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
      // Bajados un poco respecto a la versión anterior: ayuda a que la
      // segunda mano no se "pierda" tan fácil cuando está más lejos, más
      // pequeña en el encuadre, o parcialmente tapada por la otra.
      minHandDetectionConfidence: 0.25,
      minHandPresenceConfidence: 0.12,
      minTrackingConfidence: 0.08,
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

const MIN_HAND_SIZE_THRESHOLD = 0.05;

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
//
// Cada "pista" representa una mano física a lo largo del tiempo. En vez de
// confiar en el orden en que MediaPipe entrega las manos cada frame (que
// puede cambiar de un frame a otro), asignamos las manos detectadas a la
// pista más cercana a su posición anterior. Esto evita que, al cruzar las
// manos o moverlas rápido, la mano "1" y la mano "2" se intercambien.
//
// Además cada pista guarda un pequeño historial de lateralidad
// ("Left"/"Right" según MediaPipe) para decidir el signo de espejo de forma
// estable, sin que un solo frame mal clasificado lo haga parpadear.

const HAND_TRACK_MAX_MISSING_FRAMES = 10;
const MIRROR_VOTE_WINDOW = 7;

function createEmptyTrack() {
  return {
    active: false,
    wrist: null,
    handednessLabel: null,
    mirrorSign: null,
    mirrorVotes: [],
    missingFrames: 0,
  };
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

function pushMirrorVote(track, label) {
  const safeLabel = label || track.handednessLabel || "Right";
  track.mirrorVotes.push(safeLabel);
  if (track.mirrorVotes.length > MIRROR_VOTE_WINDOW) track.mirrorVotes.shift();

  const tally = {};
  for (const l of track.mirrorVotes) tally[l] = (tally[l] || 0) + 1;
  let bestLabel = safeLabel;
  let bestCount = -1;
  for (const [l, c] of Object.entries(tally)) {
    if (c > bestCount) {
      bestCount = c;
      bestLabel = l;
    }
  }
  track.handednessLabel = bestLabel;
  track.mirrorSign = bestLabel === "Left" ? 1 : -1;
}

function updateTrackFromHand(track, landmarks, handednessLabel) {
  track.active = true;
  track.wrist = { x: landmarks[0].x, y: landmarks[0].y };
  track.missingFrames = 0;
  pushMirrorVote(track, handednessLabel);
}

function markTrackMissing(track) {
  if (!track.active) return;
  track.missingFrames++;
  if (track.missingFrames > HAND_TRACK_MAX_MISSING_FRAMES) {
    track.active = false;
    track.wrist = null;
    track.handednessLabel = null;
    track.mirrorSign = null;
    track.mirrorVotes = [];
    track.missingFrames = 0;
  }
}

// Devuelve un arreglo de longitud 2 alineado con handTracks: en cada
// posición, o bien { landmarks, track } si a esa pista le tocó una mano
// este frame, o null si esa pista no tiene mano este frame.
function assignHandsToTracks(handsLandmarks, handednessList) {
  const numHands = handsLandmarks.length;
  const assignment = [null, null];

  if (numHands === 0) {
    markTrackMissing(handTracks[0]);
    markTrackMissing(handTracks[1]);
    return assignment;
  }

  const labels = handsLandmarks.map((_, i) => {
    const h = handednessList && handednessList[i] && handednessList[i][0];
    return h ? h.categoryName : null;
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

    updateTrackFromHand(handTracks[targetIndex], handsLandmarks[0], labels[0]);
    assignment[targetIndex] = { landmarks: handsLandmarks[0], track: handTracks[targetIndex] };
    markTrackMissing(handTracks[1 - targetIndex]);
    return assignment;
  }

  // Dos (o más, ya limitado a las dos primeras) manos detectadas.
  const handA = handsLandmarks[0];
  const handB = handsLandmarks[1];
  const labelA = labels[0];
  const labelB = labels[1];

  if (handTracks[0].active || handTracks[1].active) {
    // Probar las dos asignaciones posibles y quedarnos con la que menos
    // desplazamiento total implica respecto al frame anterior.
    const costNormal =
      (handTracks[0].active ? distanceBetweenPoints(handA[0], handTracks[0].wrist) : 0) +
      (handTracks[1].active ? distanceBetweenPoints(handB[0], handTracks[1].wrist) : 0);
    const costSwapped =
      (handTracks[0].active ? distanceBetweenPoints(handB[0], handTracks[0].wrist) : 0) +
      (handTracks[1].active ? distanceBetweenPoints(handA[0], handTracks[1].wrist) : 0);

    if (costSwapped < costNormal) {
      updateTrackFromHand(handTracks[0], handB, labelB);
      updateTrackFromHand(handTracks[1], handA, labelA);
      assignment[0] = { landmarks: handB, track: handTracks[0] };
      assignment[1] = { landmarks: handA, track: handTracks[1] };
      return assignment;
    }
  }

  updateTrackFromHand(handTracks[0], handA, labelA);
  updateTrackFromHand(handTracks[1], handB, labelB);
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

// ---------------- Suavizado temporal del vector de landmarks ----------------
//
// El detector siempre tiene algo de temblor frame a frame. Sin suavizar,
// ese temblor se traduce directamente en distancias más grandes al comparar
// contra las muestras guardadas (menos confianza) y en que el candidato
// reconocido cambie de un frame a otro (tarda más en confirmarse).
// Aplicamos un suavizado exponencial (EMA) ligero — con muy poco retraso
// perceptible — y lo usamos tanto al grabar muestras nuevas como al
// reconocer en vivo, para comparar siempre "manzanas con manzanas".
const SMOOTHING_ALPHA = 0.55; // 0 = sin suavizar, 1 = congelado del todo
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

function applyRotation(vector, matrix, numPointsToRotate) {
  const rotated = [];
  for (let i = 0; i < numPointsToRotate; i++) {
    const x = vector[i * 3 + 0];
    const y = vector[i * 3 + 1];
    const z = vector[i * 3 + 2];
    rotated.push(
      matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z,
      matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z,
      matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z
    );
  }
  for (let i = numPointsToRotate * 3; i < vector.length; i++) {
    rotated.push(vector[i]);
  }
  return rotated;
}

const AUGMENTATION_COPIES = 6;
// Subido de 25 a 30 grados: más tolerancia a poses ligeramente
// distintas de como se grabó originalmente (lo que pediste como
// "reconocer poses más raras").
const AUGMENTATION_MAX_DEGREES = 30;
const AUGMENTATION_NOISE_STD = 0.015;

function augmentSample(vector) {
  const augmented = [];
  const numHandPoints = Math.min(Math.floor(vector.length / 3), 42);
  for (let c = 0; c < AUGMENTATION_COPIES; c++) {
    const matrix = randomRotationMatrix(AUGMENTATION_MAX_DEGREES);
    const rotated = applyRotation(vector, matrix, numHandPoints);
    const noisy = rotated.map((v) => v + (Math.random() * 2 - 1) * AUGMENTATION_NOISE_STD);
    augmented.push(noisy);
  }
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

// ---- Almacenamiento en el navegador (localStorage) ----

const VOCAB_STORAGE_KEY = "openhands-vocabulary";
const SENSITIVITY_STORAGE_KEY = "openhands-sensitivity";
const THUMBNAIL_STORAGE_KEY = "openhands-thumbnails";

function loadVocabulary() {
  try {
    const raw = localStorage.getItem(VOCAB_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.error("No se pudo leer el vocabulario guardado:", error);
    return {};
  }
}

function saveVocabulary() {
  localStorage.setItem(VOCAB_STORAGE_KEY, JSON.stringify(vocabulary));
}

function loadThumbnails() {
  try {
    const raw = localStorage.getItem(THUMBNAIL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    return {};
  }
}

function saveThumbnails() {
  localStorage.setItem(THUMBNAIL_STORAGE_KEY, JSON.stringify(thumbnails));
}

let vocabulary = loadVocabulary();
let thumbnails = loadThumbnails();

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

function addSamplesToVocabulary(name, samples) {
  if (!vocabulary[name]) {
    vocabulary[name] = [];
  }
  vocabulary[name].push(...samples);
  saveVocabulary();
}

function deleteGesture(name) {
  delete vocabulary[name];
  delete thumbnails[name];
  saveVocabulary();
  saveThumbnails();
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
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      let addedGestures = 0;
      let addedSamples = 0;

      for (const [name, samples] of Object.entries(imported)) {
        if (!Array.isArray(samples)) continue;
        if (!vocabulary[name]) {
          vocabulary[name] = [];
          addedGestures++;
        }
        vocabulary[name].push(...samples);
        addedSamples += samples.length;
      }

      saveVocabulary();
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

    for (const [name, samples] of Object.entries(imported)) {
      if (!Array.isArray(samples)) continue;
      if (!vocabulary[name]) {
        vocabulary[name] = [];
        addedGestures++;
      }
      vocabulary[name].push(...samples);
      addedSamples += samples.length;
    }

    saveVocabulary();
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

const SAMPLES_PER_RECORDING = 25;
const MIN_CONSISTENT_SAMPLES = 3;
const RECORDING_TIMEOUT_MS = 8000;

let isRecording = false;
let captureBuffer = [];
let currentGestureName = "";
let lastNormalizedVector = null;
let lastCaptureTime = 0;
const CAPTURE_INTERVAL_MS = 100;
let recordingTimeoutId = null;
let recordingHandCountLog = [];

function startRecordingSamples() {
  const name = gestureNameInput.value.trim().toUpperCase();
  if (!name) {
    alert("Escribe el nombre de la seña primero.");
    return;
  }
  currentGestureName = name;
  captureBuffer = [];
  lastCaptureTime = 0;
  recordingHandCountLog = [];
  isRecording = true;
  recordSamplesButton.disabled = true;
  cancelRecordingButton.style.display = "";

  clearTimeout(recordingTimeoutId);
  recordingTimeoutId = setTimeout(() => {
    if (isRecording) {
      abortRecording("Se agotó el tiempo (8 segundos) sin completar la grabación.");
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
  recordSamplesButton.innerHTML = '<span class="record-dot"></span> Grabar 25 muestras';
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
  recordSamplesButton.innerHTML = '<span class="record-dot"></span> Grabar 25 muestras';
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

  const expandedBuffer = [];
  for (const sample of consistentSamples) {
    expandedBuffer.push(sample, ...augmentSample(sample));
  }

  addSamplesToVocabulary(currentGestureName, expandedBuffer);

  const thumbnail = captureThumbnail();
  if (thumbnail) {
    thumbnails[currentGestureName] = thumbnail;
    saveThumbnails();
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

  const now = performance.now();
  if (now - lastCaptureTime < CAPTURE_INTERVAL_MS) return;
  lastCaptureTime = now;

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

// Subido de 7 a 9 vecinos: votación un poco más estable a medida que
// crece el vocabulario.
const K_NEAREST = 9;
const HAND_VECTOR_LENGTH = 63;
const RELATIVE_POSITION_LENGTH = 3;
const TWO_HAND_VECTOR_LENGTH = HAND_VECTOR_LENGTH * 2 + RELATIVE_POSITION_LENGTH;

function squaredDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

function vectorSquaredDistanceToSample(vector, sample) {
  if (vector.length !== sample.length) return Infinity;

  if (vector.length === TWO_HAND_VECTOR_LENGTH) {
    const handA = vector.slice(0, HAND_VECTOR_LENGTH);
    const handB = vector.slice(HAND_VECTOR_LENGTH, HAND_VECTOR_LENGTH * 2);
    const relPos = vector.slice(HAND_VECTOR_LENGTH * 2);

    const direct = squaredDistance(vector, sample);

    const swappedRelPos = relPos.map((v) => -v);
    const swappedVector = [...handB, ...handA, ...swappedRelPos];
    const swapped = squaredDistance(swappedVector, sample);

    return Math.min(direct, swapped) / 2;
  }

  return squaredDistance(vector, sample);
}

function classifyVector(vector) {
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

// Distancia de referencia para calcular el porcentaje de confianza. Antes
// se usaba el mismo umbral configurable de sensibilidad para esto, lo que
// hacía que la confianza mostrada dependiera de dónde tuvieras puesto el
// slider (con el umbral estricto, hasta una coincidencia buena se veía con
// confianza baja, tipo 35%). Ahora es un valor fijo, así el % refleja la
// calidad real de la coincidencia sin importar tu sensibilidad configurada.
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

// El "fast confirm" muestra la palabra casi al instante cuando la
// coincidencia es muy clara, sin esperar a la ventana de votos de abajo.
//
// CAMBIO PEDIDO: antes hacían falta 2 fotogramas seguidos dentro del 65%
// del umbral — con una coincidencia tan clara como distancia 0.22 contra
// umbral 0.70 (32% del umbral) eso debería cumplirse casi siempre, pero
// con el suavizado del vector a veces la distancia oscila un poco fotograma
// a fotograma y no siempre se lograban los 2 seguidos. Ahora basta con 1
// solo fotograma dentro de un rango más generoso (80% del umbral), así una
// coincidencia clara se confirma de inmediato.
const FAST_CONFIRM_DISTANCE_RATIO = 0.8;
const FAST_CONFIRM_FRAMES = 1;
let fastConfirmCandidate = null;
let fastConfirmStreak = 0;

function processRecognition(vector) {
  if (!vector || Object.keys(vocabulary).length === 0) {
    recentCandidates = [];
    confirmedLabel = null;
    fastConfirmCandidate = null;
    fastConfirmStreak = 0;
    updateRecognitionStatus(null, null, null);
    return;
  }

  const { name, distance } = classifyVector(vector);
  const threshold = getCurrentThreshold();
  const candidate = name && distance <= threshold ? name : null;

  if (candidate && distance <= threshold * FAST_CONFIRM_DISTANCE_RATIO) {
    if (candidate === fastConfirmCandidate) {
      fastConfirmStreak++;
    } else {
      fastConfirmCandidate = candidate;
      fastConfirmStreak = 1;
    }
    if (fastConfirmStreak >= FAST_CONFIRM_FRAMES && confirmedLabel !== candidate) {
      confirmWord(candidate);
      confirmedLabel = candidate;
    }
  } else {
    fastConfirmCandidate = null;
    fastConfirmStreak = 0;
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

  if (windowWinner && windowWinnerVotes >= CONFIRM_VOTES_NEEDED && confirmedLabel !== windowWinner) {
    confirmWord(windowWinner);
    confirmedLabel = windowWinner;
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

  peer = new Peer();

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
  });
}

async function getCallMediaStream() {
  if (callMediaStream) return callMediaStream;
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

let missedFrameCount = 0;
const MAX_MISSED_FRAMES = 15;

let recognitionFrameCounter = 0;
const RECOGNITION_FRAME_INTERVAL = 1;

function predictLoop() {
  if (cameraStream && handLandmarker && cameraPreview.readyState >= 2) {
    const rawResults = handLandmarker.detectForVideo(cameraPreview, performance.now());

    const rawLandmarks = rawResults.landmarks || [];
    const rawHandedness = rawResults.handedness || [];
    const keptIndices = [];
    for (let i = 0; i < rawLandmarks.length; i++) {
      if (computeHandSizeInFrame(rawLandmarks[i]) >= MIN_HAND_SIZE_THRESHOLD) {
        keptIndices.push(i);
      }
    }
    const results = {
      landmarks: keptIndices.map((i) => rawLandmarks[i]),
      handedness: keptIndices.map((i) => rawHandedness[i]),
    };

    drawHands(results);

    if (results.landmarks.length > 0) {
      missedFrameCount = 0;

      // Asignamos cada mano detectada a su pista persistente (ver sección
      // "Seguimiento estable de manos" más arriba) en vez de confiar en el
      // orden crudo que entrega el detector.
      const assignment = assignHandsToTracks(results.landmarks, results.handedness);
      const slotA = assignment[0];
      const slotB = assignment[1];

      if (slotA && slotB) {
        const v0 = normalizeLandmarks(slotA.landmarks, slotA.track.mirrorSign);
        const v1 = normalizeLandmarks(slotB.landmarks, slotB.track.mirrorSign);
        const relPos = computeRelativeHandPosition(slotA.landmarks, slotB.landmarks, slotA.track.mirrorSign);
        lastNormalizedVector = smoothVector([...v0, ...v1, ...relPos]);
        updateLandmarksInfo(lastNormalizedVector, slotA.track.handednessLabel);
      } else if (slotA || slotB) {
        const only = slotA || slotB;
        lastNormalizedVector = smoothVector(normalizeLandmarks(only.landmarks, only.track.mirrorSign));
        updateLandmarksInfo(lastNormalizedVector, only.track.handednessLabel);
      } else {
        lastNormalizedVector = null;
        smoothedVectorState = null;
        updateLandmarksInfo(null, null);
      }
    } else {
      missedFrameCount++;
      if (missedFrameCount > MAX_MISSED_FRAMES) {
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

renderVocabularyList();
initHandLandmarker();