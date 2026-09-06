import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

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
    // Resolución reducida a propósito: una imagen más chica se procesa
    // MUCHO más rápido (el modelo de manos la reduce internamente de
    // todos modos), sin perder precisión real en la detección.
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
  resetChiralityState();
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
      // Hasta 2 manos: si se deja en 1, MediaPipe descarta la segunda
      // mano aunque esté presente en el encuadre. El reconocimiento de
      // la seña sigue usando solo la mano principal (results.landmarks[0]),
      // pero con esto ambas manos se detectan y se dibujan correctamente.
      numHands: 2,
      // Subido de 0.3: con ese valor el detector era muy permisivo y a
      // veces confundía la cara (u otra zona de piel) con una mano, o
      // dejaba un "fantasma" de mano flotando en el aire un rato
      // después de que la mano real ya no estaba en el encuadre. Con
      // umbrales más altos exige más certeza antes de decir "esto es
      // una mano".
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
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

const MIN_HAND_SIZE_THRESHOLD = 0.15;

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

// Memoria de lateralidad POR MANO (índice 0 y 1), no compartida entre
// ambas. Antes había una sola variable global: si en un mismo
// fotograma se procesaban dos manos, la segunda pisaba la memoria de
// la primera y podía arruinar el espejo de cualquiera de las dos.
let lastStableChiralitySigns = [null, null];

function resetChiralityState() {
  lastStableChiralitySigns = [null, null];
}

function computeChiralitySign(landmarks, handIndex) {
  const wrist = landmarks[0];
  const indexMcp = landmarks[5];
  const middleMcp = landmarks[9];
  const pinkyMcp = landmarks[17];

  const v1 = { x: indexMcp.x - wrist.x, y: indexMcp.y - wrist.y, z: indexMcp.z - wrist.z };
  const v2 = { x: middleMcp.x - wrist.x, y: middleMcp.y - wrist.y, z: middleMcp.z - wrist.z };
  const v3 = { x: pinkyMcp.x - wrist.x, y: pinkyMcp.y - wrist.y, z: pinkyMcp.z - wrist.z };

  const crossX = v2.y * v3.z - v2.z * v3.y;
  const crossY = v2.z * v3.x - v2.x * v3.z;
  const crossZ = v2.x * v3.y - v2.y * v3.x;

  const tripleProduct = v1.x * crossX + v1.y * crossY + v1.z * crossZ;
  const currentSign = tripleProduct >= 0 ? 1 : -1;

  const CHIRALITY_CONFIDENCE_THRESHOLD = 0.0004;

  if (
    lastStableChiralitySigns[handIndex] === null ||
    Math.abs(tripleProduct) > CHIRALITY_CONFIDENCE_THRESHOLD
  ) {
    lastStableChiralitySigns[handIndex] = currentSign;
  }

  return lastStableChiralitySigns[handIndex];
}

function normalizeLandmarks(landmarks, handIndex = 0) {
  const wrist = landmarks[0];
  const mirror = computeChiralitySign(landmarks, handIndex);

  const translated = landmarks.map((p) => ({
    x: (p.x - wrist.x) * mirror,
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

function updateLandmarksInfo(hands, handednessList) {
  if (!hands || hands.length === 0) {
    landmarksInfo.textContent = "Sin manos detectadas — vector de landmarks no disponible.";
    return;
  }

  const label =
    handednessList && handednessList[0] && handednessList[0][0]
      ? handednessList[0][0].categoryName
      : "Desconocida";
  const vector = normalizeLandmarks(hands[0]);

  const fingertipIndex = 8;
  const fx = vector[fingertipIndex * 3 + 0];
  const fy = vector[fingertipIndex * 3 + 1];
  const fz = vector[fingertipIndex * 3 + 2];

  landmarksInfo.textContent =
    `Mano 1 (MediaPipe dice: ${label}) — vector normalizado: ${vector.length} valores | ` +
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

function applyRotation(vector, matrix) {
  const rotated = [];
  const numPoints = vector.length / 3;
  for (let i = 0; i < numPoints; i++) {
    const x = vector[i * 3 + 0];
    const y = vector[i * 3 + 1];
    const z = vector[i * 3 + 2];
    rotated.push(
      matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z,
      matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z,
      matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z
    );
  }
  return rotated;
}

const AUGMENTATION_COPIES = 4;
const AUGMENTATION_MAX_DEGREES = 25;
const AUGMENTATION_NOISE_STD = 0.015;

function augmentSample(vector) {
  const augmented = [];
  for (let c = 0; c < AUGMENTATION_COPIES; c++) {
    const matrix = randomRotationMatrix(AUGMENTATION_MAX_DEGREES);
    const rotated = applyRotation(vector, matrix);
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
const vocabularyList = document.getElementById("vocabulary-list");
const sensitivitySlider = document.getElementById("sensitivity-slider");

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

let vocabulary = loadVocabulary();

function addSamplesToVocabulary(name, samples) {
  if (!vocabulary[name]) {
    vocabulary[name] = [];
  }
  vocabulary[name].push(...samples);
  saveVocabulary();
}

function deleteGesture(name) {
  delete vocabulary[name];
  saveVocabulary();
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
    const row = document.createElement("div");
    row.className = "vocab-row";
    row.innerHTML = `
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

saveOfficialVocabButton.addEventListener("click", async () => {
  if (Object.keys(vocabulary).length === 0) {
    alert("No hay ningún vocabulario entrenado todavía para guardar.");
    return;
  }

  const jsonText = JSON.stringify(vocabulary, null, 2);

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: "default-vocabulary.json",
        types: [{ description: "Archivo JSON", accept: { "application/json": [".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(jsonText);
      await writable.close();
      alert(
        "Archivo guardado. Ahora en la terminal ejecuta:\n\n" +
        "git add .\ngit commit -m \"Actualizar vocabulario\"\ngit push"
      );
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error("No se pudo guardar directamente:", error);
    }
  }

  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "default-vocabulary.json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  alert("Se descargó a tu carpeta de Descargas. Muévelo a la carpeta del proyecto (ya con el nombre correcto).");
});

// ---- Sensibilidad de reconocimiento ----

const MIN_THRESHOLD = 0.12;
const MAX_THRESHOLD = 0.55;

function loadSensitivity() {
  const raw = localStorage.getItem(SENSITIVITY_STORAGE_KEY);
  return raw !== null ? Number(raw) : 50;
}

function getCurrentThreshold() {
  const value = Number(sensitivitySlider.value);
  return MIN_THRESHOLD + (value / 100) * (MAX_THRESHOLD - MIN_THRESHOLD);
}

sensitivitySlider.value = loadSensitivity();
sensitivitySlider.addEventListener("input", () => {
  localStorage.setItem(SENSITIVITY_STORAGE_KEY, sensitivitySlider.value);
});

// ---- Captura de muestras ----

const SAMPLES_PER_RECORDING = 15;

let isRecording = false;
let captureBuffer = [];
let currentGestureName = "";
let lastNormalizedVector = null;
let lastCaptureTime = 0;
const CAPTURE_INTERVAL_MS = 150;

function startRecordingSamples() {
  const name = gestureNameInput.value.trim().toUpperCase();
  if (!name) {
    alert("Escribe el nombre de la seña primero.");
    return;
  }
  currentGestureName = name;
  captureBuffer = [];
  lastCaptureTime = 0;
  isRecording = true;
  recordSamplesButton.disabled = true;
}

function finishRecordingSamples(success) {
  isRecording = false;
  recordSamplesButton.disabled = false;
  recordSamplesButton.innerHTML = '<span class="record-dot"></span> Grabar 15 muestras';

  if (!success) {
    alert("No se detectó la mano lo suficiente. Intenta de nuevo mostrando bien la mano.");
    captureBuffer = [];
    return;
  }

  const expandedBuffer = [];
  for (const sample of captureBuffer) {
    expandedBuffer.push(sample, ...augmentSample(sample));
  }

  addSamplesToVocabulary(currentGestureName, expandedBuffer);
  captureBuffer = [];
  renderVocabularyList();
}

recordSamplesButton.addEventListener("click", () => {
  if (!isRecording) {
    startRecordingSamples();
  }
});

function captureSampleIfRecording() {
  if (!isRecording) return;
  if (!lastNormalizedVector) return;

  const now = performance.now();
  if (now - lastCaptureTime < CAPTURE_INTERVAL_MS) return;
  lastCaptureTime = now;

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
let recentLabel = null;
let recentCount = 0;
let confirmedLabel = null;

const CONFIRM_FRAMES = 8;
const K_NEAREST = 7;
const HAND_VECTOR_LENGTH = 63; // 21 landmarks x (x, y, z)

/**
 * Distancia euclidiana AL CUADRADO (sin la raíz). Para comparar y
 * ordenar por cercanía da exactamente el mismo resultado que la
 * distancia real (si a² < b² entonces a < b), pero evita calcular
 * Math.sqrt miles de veces por fotograma — eso era buena parte del
 * lag: classifyVector corre en cada fotograma y antes sacaba raíz
 * cuadrada por CADA muestra del vocabulario completo. Ahora solo se
 * saca raíz al final, para los pocos vecinos ya seleccionados.
 */
function squaredDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

/**
 * Distancia AL CUADRADO entre el vector actual y una muestra guardada.
 *
 * - Si ambos son de una sola mano (63 valores): distancia euclidiana
 *   al cuadrado normal.
 * - Si ambos son de dos manos (126 valores = dos manos concatenadas):
 *   se prueba tal cual y también con las dos mitades intercambiadas,
 *   y se usa la menor. Así no importa cuál mano haya quedado
 *   "primero" al concatenar — lo que incluye el caso de una seña de
 *   dos manos hecha en espejo completo (donde las dos manos
 *   intercambian de posición y de forma). Se normaliza por la
 *   cantidad de manos (dividiendo entre 2, ya que trabajamos al
 *   cuadrado) para que el umbral de sensibilidad siga significando lo
 *   mismo con dos manos.
 */
function vectorSquaredDistanceToSample(vector, sample) {
  if (vector.length !== sample.length) return Infinity;

  const numHandsInVector = vector.length / HAND_VECTOR_LENGTH;

  if (numHandsInVector === 2) {
    const direct = squaredDistance(vector, sample);
    const swappedVector = [
      ...vector.slice(HAND_VECTOR_LENGTH),
      ...vector.slice(0, HAND_VECTOR_LENGTH),
    ];
    const swapped = squaredDistance(swappedVector, sample);
    return Math.min(direct, swapped) / numHandsInVector;
  }

  return squaredDistance(vector, sample);
}

function classifyVector(vector) {
  const allDistances = [];
  for (const [name, samples] of Object.entries(vocabulary)) {
    for (const sample of samples) {
      allDistances.push({ name, sqDistance: vectorSquaredDistanceToSample(vector, sample) });
    }
  }

  if (allDistances.length === 0) {
    return { name: null, distance: Infinity };
  }

  allDistances.sort((a, b) => a.sqDistance - b.sqDistance);
  const nearest = allDistances.slice(0, Math.min(K_NEAREST, allDistances.length));

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

  const state = candidate ? `coincide con "${candidate}"` : "no coincide con ninguna seña conocida";
  recognitionStatus.textContent =
    `Comparando con ${totalGestures} seña(s) — ${state} ` +
    `(distancia ${distance.toFixed(2)}, umbral ${threshold.toFixed(2)})`;
}

function processRecognition(vector) {
  if (!vector || Object.keys(vocabulary).length === 0) {
    recentLabel = null;
    recentCount = 0;
    confirmedLabel = null;
    updateRecognitionStatus(null, null, null);
    return;
  }

  const { name, distance } = classifyVector(vector);
  const threshold = getCurrentThreshold();
  const candidate = name && distance <= threshold ? name : null;

  if (candidate === recentLabel) {
    recentCount++;
  } else {
    recentLabel = candidate;
    recentCount = 1;
  }

  if (candidate !== confirmedLabel) {
    confirmedLabel = null;
  }

  if (candidate && recentCount >= CONFIRM_FRAMES && confirmedLabel !== candidate) {
    confirmWord(candidate);
    confirmedLabel = candidate;
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

// Tolera hasta 6 fotogramas seguidos sin detección antes de "dar por
// perdida" la mano. Así, un parpadeo momentáneo del detector (algo
// completamente normal al mover la mano) no reinicia todo de golpe.
let missedFrameCount = 0;
const MAX_MISSED_FRAMES = 6;

// El reconocimiento (comparar contra TODO el vocabulario) es lo más
// pesado del bucle, y crece a medida que se entrenan más señas. Antes
// se ejecutaba en cada fotograma (hasta 60 veces por segundo), lo cual
// saturaba el hilo principal y causaba el lag de cámara / la demora en
// "reaccionar" a la mano. Ahora se ejecuta 1 de cada 3 fotogramas —la
// cámara y el dibujo del esqueleto siguen actualizándose en cada
// fotograma, solo se espacía la parte pesada.
let recognitionFrameCounter = 0;
const RECOGNITION_FRAME_INTERVAL = 3;

function predictLoop() {
  if (cameraStream && handLandmarker && cameraPreview.readyState >= 2) {
    const rawResults = handLandmarker.detectForVideo(cameraPreview, performance.now());

    // Se descartan por completo las manos demasiado chicas en el
    // encuadre (mano muy alejada de la cámara): no se dibujan, no
    // cuentan como "mano detectada" y no se usan para reconocer. Antes
    // solo se anulaba el vector de reconocimiento pero el esqueleto
    // seguía dibujándose y seguía contando como detección.
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
    updateLandmarksInfo(results.landmarks, results.handedness);

    if (results.landmarks.length > 0) {
      missedFrameCount = 0;
      // Cada mano se normaliza por separado (con su propio espejo por
      // lateralidad, usando su propio índice de memoria — ver arriba).
      // Si hay dos manos, se concatenan en un solo vector para poder
      // reconocer señas de dos manos. El orden en que queden no
      // importa: vectorSquaredDistanceToSample prueba ambos órdenes,
      // así una seña de dos manos también se reconoce si se hace en
      // espejo (con los roles de las manos intercambiados).
      const handVectors = results.landmarks
        .slice(0, 2)
        .map((lm, idx) => normalizeLandmarks(lm, idx));
      lastNormalizedVector =
        handVectors.length === 2 ? [...handVectors[0], ...handVectors[1]] : handVectors[0];
    } else {
      missedFrameCount++;
      if (missedFrameCount > MAX_MISSED_FRAMES) {
        lastNormalizedVector = null;
        resetChiralityState();
      }
      // si no se superó el límite, se conserva el último vector válido
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

renderVocabularyList();
initHandLandmarker();