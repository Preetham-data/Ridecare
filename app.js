/**
 * ==============================================================================
 * Motorcycle Crash Detector - app.js
 * ==============================================================================
 * A client-side, zero-framework safety web application designed for mobile phones.
 * 
 * Features:
 * 1. Screen Wake Lock: Keeps the phone display active while riding.
 * 2. Accelerometer Monitoring: Reads X, Y, Z motion and computes total G-force.
 * 3. Crash Detection Algorithm:
 *    - Step 1: Detects sudden violent jolt (magnitude > 28 m/s² / ~2.9 G).
 *    - Step 2: Verifies ~5 seconds of subsequent stillness (phone motionless on ground).
 * 4. Emergency Alarm:
 *    - Fullscreen flashing red takeover.
 *    - 15-second countdown timer.
 *    - Synthesized siren sound via Web Audio API.
 *    - Hardware vibration pulses.
 *    - Large "I'M OK" cancel button.
 * 5. Simulation Mode: Instant test trigger for demonstration.
 * ==============================================================================
 */

// Strict mode for cleaner code and safety
'use strict';

/* ------------------------------------------------------------------------------
 * 1. CONFIGURATION & THRESHOLDS
 * ------------------------------------------------------------------------------ */
// Gravitational constant on Earth (m/s²)
const GRAVITY = 9.80665;

// Jolt threshold: A sudden impact force greater than 28 m/s² (~2.85 G).
// Normal motorcycle vibration rarely spikes above 20 m/s² unless hitting a severe impact.
const JOLT_THRESHOLD = 28.0;

// Maximum acceptable movement while lying still (m/s²).
// When at rest, total magnitude is approx 9.8 m/s² (1G of gravity).
// If magnitude stays within 9.8 ± 3.0 m/s² and doesn't fluctuate wildly, it counts as still.
const STILLNESS_MIN_MAG = GRAVITY - 3.2; // ~6.6 m/s²
const STILLNESS_MAX_MAG = GRAVITY + 3.2; // ~13.0 m/s²

// Time in milliseconds the phone must remain still after the jolt to confirm a crash.
const STILLNESS_DURATION_MS = 5000; // 5 seconds

// Countdown before sending emergency SOS
const COUNTDOWN_SECONDS = 15;

/* ------------------------------------------------------------------------------
 * 2. APPLICATION STATE
 * ------------------------------------------------------------------------------ */
let isRideActive = false;           // Is the rider currently on an active trip?
let wakeLockSentinel = null;       // Screen Wake Lock API handle
let geoWatchId = null;             // Geolocation watch ID
let audioCtx = null;               // Web Audio API context for synthesized siren
let sirenIntervalId = null;        // Interval for siren sound frequency modulation
let sirenOscillator = null;        // Active audio oscillator
let sirenGainNode = null;          // Active audio gain node
let vibrationIntervalId = null;    // Interval for repeating vibration pattern
let countdownIntervalId = null;    // Interval for 15-second countdown
let countdownValue = COUNTDOWN_SECONDS;

// Crash Detection State Machine
// States: 'IDLE' | 'MONITORING' | 'VERIFYING_STILLNESS' | 'CRASH_TRIGGERED'
let detectionState = 'IDLE';
let joltTimestamp = 0;             // When the major impact spike was registered
let stillnessCheckInterval = null; // Animation/timer ticker for the 5-second stillness window

/* ------------------------------------------------------------------------------
 * 3. DOM ELEMENT REFERENCES
 * ------------------------------------------------------------------------------ */
const toggleRideBtn = document.getElementById('toggleRideBtn');
const toggleRideText = document.getElementById('toggleRideText');
const simulateCrashBtn = document.getElementById('simulateCrashBtn');
const cancelCrashBtn = document.getElementById('cancelCrashBtn');
const sosResetBtn = document.getElementById('sosResetBtn');

const statusBadge = document.getElementById('statusBadge');
const wakeLockStatus = document.getElementById('wakeLockStatus');
const gpsStatus = document.getElementById('gpsStatus');
const sensorStatus = document.getElementById('sensorStatus');

const accXElem = document.getElementById('accX');
const accYElem = document.getElementById('accY');
const accZElem = document.getElementById('accZ');
const accMagnitudeElem = document.getElementById('accMagnitude');
const meterFill = document.getElementById('meterFill');

const detectorStatusText = document.getElementById('detectorStatusText');
const stillnessTimerBox = document.getElementById('stillnessTimerBox');
const stillnessProgressFill = document.getElementById('stillnessProgressFill');
const stillnessSecondsText = document.getElementById('stillnessSecondsText');

const gpsCoordinatesElem = document.getElementById('gpsCoordinates');
const gpsSpeedElem = document.getElementById('gpsSpeed');

const crashOverlay = document.getElementById('crashOverlay');
const countdownNumber = document.getElementById('countdownNumber');
const sosDispatchedBox = document.getElementById('sosDispatchedBox');

/* ------------------------------------------------------------------------------
 * 4. SCREEN WAKE LOCK API (Requirement 6: Keep screen awake during ride)
 * ------------------------------------------------------------------------------ */

/**
 * Requests the browser to keep the display awake.
 * Prevents the phone from sleeping while mounted on the bike.
 */
async function requestScreenWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockStatus.textContent = 'Active';
      wakeLockStatus.style.color = '#4ade80';

      // If the system or user switches apps, the wake lock is released automatically.
      wakeLockSentinel.addEventListener('release', () => {
        if (isRideActive) {
          wakeLockStatus.textContent = 'Released';
          wakeLockStatus.style.color = '#fbbf24';
        } else {
          wakeLockStatus.textContent = 'Inactive';
          wakeLockStatus.style.color = '#38bdf8';
        }
      });
    } catch (err) {
      console.warn('Wake Lock request failed:', err.message);
      wakeLockStatus.textContent = 'Failed';
      wakeLockStatus.style.color = '#ef4444';
    }
  } else {
    wakeLockStatus.textContent = 'Unsupported';
    wakeLockStatus.style.color = '#94a3b8';
  }
}

/**
 * Releases the wake lock when the ride is finished.
 */
async function releaseScreenWakeLock() {
  if (wakeLockSentinel !== null) {
    try {
      await wakeLockSentinel.release();
    } catch (err) {
      console.warn('Wake Lock release error:', err.message);
    }
    wakeLockSentinel = null;
    wakeLockStatus.textContent = 'Inactive';
    wakeLockStatus.style.color = '#38bdf8';
  }
}

// Re-acquire wake lock if user switches back to this browser tab while ride is running
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && isRideActive) {
    await requestScreenWakeLock();
  }
});

/* ------------------------------------------------------------------------------
 * 5. LOUD ALARM SOUND (Web Audio API)
 * ------------------------------------------------------------------------------
 * Synthesizes a loud, urgent dual-tone emergency siren in real time.
 * Requires no external audio files, works completely offline.
 */

/**
 * Initializes or unlocks the AudioContext on user interaction.
 */
function initAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

/**
 * Starts a loud alternating siren sound.
 */
function startAlarmSound() {
  try {
    initAudioContext();
    if (!audioCtx) return;

    // Create oscillator and gain (volume) nodes
    sirenOscillator = audioCtx.createOscillator();
    sirenGainNode = audioCtx.createGain();

    // Sawtooth wave sounds harsh and cutting like an emergency siren
    sirenOscillator.type = 'sawtooth';
    sirenOscillator.frequency.setValueAtTime(750, audioCtx.currentTime);

    // Set high volume
    sirenGainNode.gain.setValueAtTime(0.85, audioCtx.currentTime);

    // Connect nodes to phone speakers
    sirenOscillator.connect(sirenGainNode);
    sirenGainNode.connect(audioCtx.destination);
    sirenOscillator.start();

    // Alternate frequency between 750Hz and 1150Hz every 350ms (ambulance siren pattern)
    let isHighPitch = false;
    sirenIntervalId = setInterval(() => {
      if (!audioCtx || !sirenOscillator) return;
      const targetFreq = isHighPitch ? 750 : 1150;
      sirenOscillator.frequency.cancelScheduledValues(audioCtx.currentTime);
      sirenOscillator.frequency.linearRampToValueAtTime(targetFreq, audioCtx.currentTime + 0.1);
      isHighPitch = !isHighPitch;
    }, 350);

  } catch (err) {
    console.warn('Audio alarm playback error:', err);
  }
}

/**
 * Stops the alarm sound and cleans up audio nodes.
 */
function stopAlarmSound() {
  if (sirenIntervalId) {
    clearInterval(sirenIntervalId);
    sirenIntervalId = null;
  }
  if (sirenOscillator) {
    try {
      sirenOscillator.stop();
      sirenOscillator.disconnect();
    } catch (e) {
      // Ignore if already stopped
    }
    sirenOscillator = null;
  }
  if (sirenGainNode) {
    sirenGainNode.disconnect();
    sirenGainNode = null;
  }
}

/* ------------------------------------------------------------------------------
 * 6. HARDWARE VIBRATION
 * ------------------------------------------------------------------------------ */

/**
 * Starts repeated vibration pulse pattern on supported mobile devices.
 */
function startVibration() {
  if ('vibrate' in navigator) {
    // Vibration pattern: Vibrate 600ms, pause 200ms, vibrate 600ms, pause 400ms
    const pattern = [600, 200, 600, 400];
    navigator.vibrate(pattern);

    // Repeat every 1.8 seconds while alarm is active
    vibrationIntervalId = setInterval(() => {
      navigator.vibrate(pattern);
    }, 1800);
  }
}

/**
 * Stops all vibration.
 */
function stopVibration() {
  if (vibrationIntervalId) {
    clearInterval(vibrationIntervalId);
    vibrationIntervalId = null;
  }
  if ('vibrate' in navigator) {
    navigator.vibrate(0);
  }
}

/* ------------------------------------------------------------------------------
 * 7. GEOLOCATION TRACKING (Location for Emergency Dispatch)
 * ------------------------------------------------------------------------------ */

/**
 * Starts tracking the rider's coordinates and speed.
 */
function startLocationTracking() {
  if ('geolocation' in navigator) {
    gpsStatus.textContent = 'Acquiring...';
    gpsStatus.style.color = '#fbbf24';

    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        gpsStatus.textContent = 'Locked';
        gpsStatus.style.color = '#4ade80';

        const lat = pos.coords.latitude.toFixed(5);
        const lon = pos.coords.longitude.toFixed(5);
        gpsCoordinatesElem.textContent = `${lat}, ${lon}`;

        if (pos.coords.speed !== null && !isNaN(pos.coords.speed)) {
          // Speed comes in m/s, convert to km/h
          const speedKmh = Math.max(0, pos.coords.speed * 3.6).toFixed(1);
          gpsSpeedElem.textContent = `${speedKmh} km/h`;
        } else {
          gpsSpeedElem.textContent = `0.0 km/h`;
        }
      },
      (err) => {
        console.warn('Geolocation error:', err.message);
        gpsStatus.textContent = 'Denied/Error';
        gpsStatus.style.color = '#ef4444';
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 2000
      }
    );
  } else {
    gpsStatus.textContent = 'Unsupported';
    gpsStatus.style.color = '#94a3b8';
  }
}

/**
 * Stops geolocation tracking.
 */
function stopLocationTracking() {
  if (geoWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
  gpsStatus.textContent = 'Off';
  gpsStatus.style.color = '#38bdf8';
}

/* ------------------------------------------------------------------------------
 * 8. ACCELEROMETER MOTION LISTENER & CRASH DETECTION LOGIC
 * ------------------------------------------------------------------------------
 * Algorithm:
 * 1. Read device accelerometer (including gravity).
 * 2. Calculate vector magnitude: sqrt(x² + y² + z²).
 * 3. If magnitude > 28 m/s² (~2.9G): Jolt triggered!
 * 4. Monitor subsequent 5 seconds:
 *    - If movement continues (e.g., rider hit a bump, motorcycle keeps running/moving),
 *      cancel verification because the rider is still riding.
 *    - If phone stays still (within resting gravity range 6.6 - 13.0 m/s²) for 5 continuous seconds,
 *      CRASH IS CONFIRMED! Trigger emergency alert.
 */

/**
 * Handler for the HTML5 DeviceMotionEvent
 */
function handleDeviceMotion(event) {
  if (!isRideActive) return;

  // Use acceleration with gravity if available, or fallback to standard acceleration
  const acc = event.accelerationIncludingGravity || event.acceleration;
  if (!acc) return;

  const x = acc.x || 0;
  const y = acc.y || 0;
  const z = acc.z || 0;

  // Compute 3D Euclidean magnitude: ||A|| = sqrt(x² + y² + z²)
  const magnitude = Math.sqrt(x * x + y * y + z * z);
  const gForce = magnitude / GRAVITY;

  // 1. Update live UI displays
  accXElem.textContent = x.toFixed(2);
  accYElem.textContent = y.toFixed(2);
  accZElem.textContent = z.toFixed(2);
  accMagnitudeElem.textContent = `${magnitude.toFixed(2)} m/s² (${gForce.toFixed(2)} G)`;

  // Update visual meter gauge (cap at 4G for max width)
  const meterPercentage = Math.min(100, (gForce / 4.0) * 100);
  meterFill.style.width = `${meterPercentage}%`;

  // 2. CRASH ALGORITHM EVALUATION
  if (detectionState === 'MONITORING') {
    // Check for severe impact jolt
    if (magnitude >= JOLT_THRESHOLD) {
      startStillnessVerification(magnitude, gForce);
    }
  } else if (detectionState === 'VERIFYING_STILLNESS') {
    // During the 5-second stillness window, check if the phone is experiencing active movement.
    // A severe departure from resting gravity means continuous riding or active motion (e.g. pothole).
    const isMovingExcessively = (magnitude < STILLNESS_MIN_MAG - 4.0) || (magnitude > STILLNESS_MAX_MAG + 5.0);

    if (isMovingExcessively) {
      // Bike is still moving / riding resumed; cancel verification
      cancelStillnessVerification('Motion detected: Pothole or bump filtered out. Ride safe!');
    }
  }
}

/**
 * Step 1 of Crash: Major jolt detected.
 * Begins the 5-second countdown to verify if the phone remains stationary on the ground.
 */
function startStillnessVerification(magnitude, gForce) {
  detectionState = 'VERIFYING_STILLNESS';
  joltTimestamp = Date.now();

  // Update status badge & card
  statusBadge.textContent = 'CHECKING IMPACT';
  statusBadge.className = 'status-badge status-warning';

  detectorStatusText.innerHTML = `⚠️ <strong style="color: #fbbf24;">Sudden impact detected:</strong> ${magnitude.toFixed(1)} m/s² (${gForce.toFixed(1)} G).<br>Checking if motionless for 5 seconds...`;
  stillnessTimerBox.classList.remove('hidden');

  // Start progress updater
  if (stillnessCheckInterval) clearInterval(stillnessCheckInterval);

  stillnessCheckInterval = setInterval(() => {
    if (detectionState !== 'VERIFYING_STILLNESS') {
      clearInterval(stillnessCheckInterval);
      return;
    }

    const elapsedMs = Date.now() - joltTimestamp;
    const progressPercent = Math.min(100, (elapsedMs / STILLNESS_DURATION_MS) * 100);
    const elapsedSeconds = (elapsedMs / 1000).toFixed(1);

    stillnessProgressFill.style.width = `${progressPercent}%`;
    stillnessSecondsText.textContent = `${elapsedSeconds}s / 5.0s`;

    // If 5 seconds of continuous stillness has elapsed: CRASH CONFIRMED!
    if (elapsedMs >= STILLNESS_DURATION_MS) {
      clearInterval(stillnessCheckInterval);
      triggerCrashAlarm('Severe impact detected followed by 5s stillness.');
    }
  }, 100);
}

/**
 * Cancels stillness verification when ongoing riding motion is detected.
 */
function cancelStillnessVerification(reason) {
  if (stillnessCheckInterval) {
    clearInterval(stillnessCheckInterval);
    stillnessCheckInterval = null;
  }

  detectionState = 'MONITORING';
  statusBadge.textContent = 'RIDING';
  statusBadge.className = 'status-badge status-active';

  stillnessTimerBox.classList.add('hidden');
  stillnessProgressFill.style.width = '0%';
  detectorStatusText.textContent = reason || 'Monitoring ride. Accelerometer active.';
}

/* ------------------------------------------------------------------------------
 * 9. EMERGENCY CRASH ALARM OVERLAY (Requirement 4 & 5)
 * ------------------------------------------------------------------------------
 * Shows full red screen, blares loud siren, vibrates phone, and counts down 15s.
 */

/**
 * Triggers the 15-second emergency countdown and alarm.
 */
function triggerCrashAlarm(reasonMessage) {
  detectionState = 'CRASH_TRIGGERED';

  // Make sure stillness timer is cleaned up
  if (stillnessCheckInterval) {
    clearInterval(stillnessCheckInterval);
    stillnessCheckInterval = null;
  }
  stillnessTimerBox.classList.add('hidden');

  // 1. Show fullscreen red modal
  crashOverlay.classList.remove('hidden');
  sosDispatchedBox.classList.add('hidden');
  cancelCrashBtn.classList.remove('hidden');

  // 2. Start alarm sound & vibration
  startAlarmSound();
  startVibration();

  // 3. Start 15-second countdown
  countdownValue = COUNTDOWN_SECONDS;
  countdownNumber.textContent = countdownValue;

  if (countdownIntervalId) clearInterval(countdownIntervalId);

  countdownIntervalId = setInterval(() => {
    countdownValue -= 1;
    countdownNumber.textContent = countdownValue;

    if (countdownValue <= 0) {
      clearInterval(countdownIntervalId);
      countdownIntervalId = null;
      handleEmergencyDispatch();
    }
  }, 1000);

  // Update detector text in background
  detectorStatusText.textContent = `🚨 CRASH CONFIRMED: ${reasonMessage || 'Manual simulation.'}`;
}

/**
 * Action executed when the 15-second countdown reaches 0 without cancellation.
 */
function handleEmergencyDispatch() {
  // Show dispatch message
  sosDispatchedBox.classList.remove('hidden');
  cancelCrashBtn.classList.add('hidden');

  // In a production backend app, an SMS / Webhook / Twilio call with GPS coordinates
  // would be sent here.
  const coords = gpsCoordinatesElem.textContent;
  console.log(`EMERGENCY SOS: Dispatching alert to emergency contacts with coordinates: ${coords}`);
}

/**
 * Cancels the emergency alarm when the huge green "I'M OK" button is tapped.
 */
function cancelCrashAlarm() {
  // 1. Stop audio siren & vibration
  stopAlarmSound();
  stopVibration();

  // 2. Stop countdown interval
  if (countdownIntervalId) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }

  // 3. Hide fullscreen overlay
  crashOverlay.classList.add('hidden');
  sosDispatchedBox.classList.add('hidden');
  cancelCrashBtn.classList.remove('hidden');

  // 4. Reset detection state back to active ride monitoring
  if (isRideActive) {
    detectionState = 'MONITORING';
    statusBadge.textContent = 'RIDING';
    statusBadge.className = 'status-badge status-active';
    detectorStatusText.textContent = 'Alarm cancelled by rider. Resumed monitoring.';
  } else {
    detectionState = 'IDLE';
    statusBadge.textContent = 'IDLE';
    statusBadge.className = 'status-badge status-idle';
    detectorStatusText.textContent = 'Ride stopped. Press "Start Ride" to monitor.';
  }
}

/* ------------------------------------------------------------------------------
 * 10. RIDE START / STOP CONTROLLER & PERMISSION REQUESTS
 * ------------------------------------------------------------------------------ */

/**
 * Requests motion & location permissions and toggles ride tracking on/off.
 */
async function toggleRide() {
  // Unlock audio context on initial button press for browser autoplay policy
  initAudioContext();

  if (!isRideActive) {
    // START RIDE
    // A. Request iOS 13+ Motion Permission (if required by Safari)
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const permissionState = await DeviceMotionEvent.requestPermission();
        if (permissionState !== 'granted') {
          alert('Accelerometer access was denied. Motion detection cannot function without this permission.');
          return;
        }
      } catch (err) {
        console.warn('DeviceMotionEvent permission error:', err);
      }
    }

    // B. Start listening to Accelerometer
    if ('DeviceMotionEvent' in window) {
      window.addEventListener('devicemotion', handleDeviceMotion, true);
      sensorStatus.textContent = 'Active';
      sensorStatus.style.color = '#4ade80';
    } else {
      sensorStatus.textContent = 'Unsupported';
      sensorStatus.style.color = '#ef4444';
      alert('Device motion sensors are not supported on this browser/device.');
    }

    // C. Request & Keep Screen Awake (Wake Lock)
    await requestScreenWakeLock();

    // D. Start Location Tracking (GPS)
    startLocationTracking();

    // E. Update UI state
    isRideActive = true;
    detectionState = 'MONITORING';

    toggleRideBtn.classList.remove('btn-start');
    toggleRideBtn.classList.add('btn-stop');
    toggleRideText.textContent = 'STOP RIDE';

    statusBadge.textContent = 'RIDING';
    statusBadge.className = 'status-badge status-active';

    detectorStatusText.textContent = 'Ride active. Monitoring accelerometer for sudden impacts...';

  } else {
    // STOP RIDE
    stopRide();
  }
}

/**
 * Halts ride monitoring and releases all resources.
 */
async function stopRide() {
  isRideActive = false;
  detectionState = 'IDLE';

  // 1. Detach motion listener
  window.removeEventListener('devicemotion', handleDeviceMotion, true);
  sensorStatus.textContent = 'Waiting';
  sensorStatus.style.color = '#38bdf8';

  // 2. Release wake lock
  await releaseScreenWakeLock();

  // 3. Stop GPS
  stopLocationTracking();

  // 4. Reset stillness timers if running
  if (stillnessCheckInterval) {
    clearInterval(stillnessCheckInterval);
    stillnessCheckInterval = null;
  }
  stillnessTimerBox.classList.add('hidden');

  // 5. Update UI
  toggleRideBtn.classList.remove('btn-stop');
  toggleRideBtn.classList.add('btn-start');
  toggleRideText.textContent = 'START RIDE';

  statusBadge.textContent = 'IDLE';
  statusBadge.className = 'status-badge status-idle';

  detectorStatusText.textContent = 'Ride ended. Press "Start Ride" to monitor.';

  // Reset telemetry readouts
  accXElem.textContent = '0.00';
  accYElem.textContent = '0.00';
  accZElem.textContent = '0.00';
  accMagnitudeElem.textContent = '0.00 m/s² (0.00 G)';
  meterFill.style.width = '0%';
}

/* ------------------------------------------------------------------------------
 * 11. EVENT LISTENERS
 * ------------------------------------------------------------------------------ */

// Start / Stop Ride
toggleRideBtn.addEventListener('click', toggleRide);

// Cancel crash button ("I'M OK")
cancelCrashBtn.addEventListener('click', cancelCrashAlarm);

// Reset system after SOS dispatch
sosResetBtn.addEventListener('click', () => {
  cancelCrashAlarm();
  stopRide();
});

// Simulate Crash button (Requirement 5: Instant demo)
simulateCrashBtn.addEventListener('click', () => {
  // Ensure audio context is ready
  initAudioContext();
  triggerCrashAlarm('Triggered by Simulate Crash demo button.');
});
