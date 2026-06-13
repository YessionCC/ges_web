import * as THREE from "./vendor/three.module.js";
import { GLTFLoader } from "./vendor/GLTFLoader.js";

const MAGIC = "GBPRD001";
const canvas = document.getElementById("canvas");
const statusEl = document.getElementById("status");
const fileInput = document.getElementById("fileInput");
const modeSelect = document.getElementById("modeSelect");
const flipVInput = document.getElementById("flipV");
const lightIntensityInput = document.getElementById("lightIntensity");
const lightIntensityValue = document.getElementById("lightIntensityValue");
const headlightRangeInput = document.getElementById("headlightRange");
const headlightRangeValue = document.getElementById("headlightRangeValue");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x07090a, 1);
setStatus(`Ready. WebGL max texture size: ${renderer.capabilities.maxTextureSize}.`);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
camera.position.set(0, 0.35, 2.2);

let productMesh = null;
let material = null;
let sceneRadius = 1.0;

class QuaternionOrbitController {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.target = new THREE.Vector3();
    this.rotation = new THREE.Quaternion();
    this.distance = 2.2;
    this.minDistance = 0.05;
    this.maxDistance = Infinity;
    this.rotateSpeed = 1.8;
    this.panSpeed = 0.0003;
    this.zoomSpeed = 0.0002;
    this.dampingFactor = 0.12;
    this.enableDamping = true;

    this.state = {
      dragging: false,
      button: -1,
      lastX: 0,
      lastY: 0,
    };

    this.panVelocity = new THREE.Vector2();
    this.zoomVelocity = 0;

    this._offset = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._deltaQuat = new THREE.Quaternion();
    this._arcballStart = new THREE.Vector3();
    this._arcballEnd = new THREE.Vector3();
    this._arcballAxis = new THREE.Vector3();
    this._arcballWorldAxis = new THREE.Vector3();
    this._arcballLast = null;

    this.domElement.style.touchAction = "none";
    this._bindEvents();
    this.syncFromCamera();
  }

  _bindEvents() {
    this.domElement.addEventListener("contextmenu", (event) => event.preventDefault());
    this.domElement.addEventListener("mousedown", this._onMouseDown);
    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("mouseup", this._onMouseUp);
    this.domElement.addEventListener("wheel", this._onWheel, { passive: false });
  }

  _onMouseDown = (event) => {
    this.state.dragging = true;
    this.state.button = event.button;
    this.state.lastX = event.clientX;
    this.state.lastY = event.clientY;
    if (event.button === 0) {
      this._arcballLast = this._projectArcball(event.clientX, event.clientY);
    }
    if (event.button === 1) {
      event.preventDefault();
    }
  };

  _onMouseMove = (event) => {
    if (!this.state.dragging) {
      return;
    }
    const dx = event.clientX - this.state.lastX;
    const dy = event.clientY - this.state.lastY;
    this.state.lastX = event.clientX;
    this.state.lastY = event.clientY;

    if (this.state.button === 0) {
      this._applyArcballRotation(event.clientX, event.clientY);
      return;
    }

    if (this.state.button === 1 || this.state.button === 2) {
      this.panVelocity.x += dx;
      this.panVelocity.y += dy;
    }
  };

  _onMouseUp = () => {
    this.state.dragging = false;
    this.state.button = -1;
    this._arcballLast = null;
  };

  _onWheel = (event) => {
    event.preventDefault();
    this.zoomVelocity += event.deltaY * this.zoomSpeed;
  };

  syncFromCamera() {
    const lookMatrix = new THREE.Matrix4().lookAt(this.camera.position, this.target, this.camera.up);
    this.rotation.setFromRotationMatrix(lookMatrix).invert();
    this.distance = Math.max(this.camera.position.distanceTo(this.target), this.minDistance);
    this.updateCamera(true);
  }

  saveState() {
    this._savedTarget = this.target.clone();
    this._savedRotation = this.rotation.clone();
    this._savedDistance = this.distance;
  }

  reset() {
    if (!this._savedTarget || !this._savedRotation) {
      return;
    }
    this.target.copy(this._savedTarget);
    this.rotation.copy(this._savedRotation);
    this.distance = this._savedDistance;
    this.panVelocity.set(0, 0);
    this.zoomVelocity = 0;
    this._arcballLast = null;
    this.updateCamera(true);
  }

  setView(center, offset) {
    this.target.copy(center);
    const nextPosition = center.clone().add(offset);
    this.camera.position.copy(nextPosition);
    this.syncFromCamera();
  }

  updateCamera(force = false) {
    if (!force) {
      this._applyDeltas();
    }

    this.distance = THREE.MathUtils.clamp(this.distance, this.minDistance, this.maxDistance);
    this._offset.set(0, 0, this.distance).applyQuaternion(this.rotation);
    this.camera.position.copy(this.target).add(this._offset);
    this.camera.quaternion.copy(this.rotation);
  }

  update() {
    this.updateCamera(false);
  }

  _projectArcball(clientX, clientY) {
    const rect = this.domElement.getBoundingClientRect();
    const size = Math.max(Math.min(rect.width, rect.height), 1);
    const x = ((clientX - rect.left) / size) * 2 - rect.width / size;
    const y = rect.height / size - ((clientY - rect.top) / size) * 2;
    const projected = new THREE.Vector3(x, y, 0);
    const lengthSq = x * x + y * y;
    if (lengthSq <= 1) {
      projected.z = Math.sqrt(1 - lengthSq);
      return projected;
    }
    return projected.normalize();
  }

  _applyArcballRotation(clientX, clientY) {
    if (!this._arcballLast) {
      this._arcballLast = this._projectArcball(clientX, clientY);
      return;
    }

    this._arcballStart.copy(this._arcballLast);
    this._arcballEnd.copy(this._projectArcball(clientX, clientY));
    const dot = THREE.MathUtils.clamp(this._arcballStart.dot(this._arcballEnd), -1, 1);

    if (dot > 0.999999) {
      this._arcballLast.copy(this._arcballEnd);
      return;
    }

    this._arcballAxis.crossVectors(this._arcballStart, this._arcballEnd);
    if (this._arcballAxis.lengthSq() < 1e-10) {
      this._arcballLast.copy(this._arcballEnd);
      return;
    }

    const angle = Math.acos(dot) * this.rotateSpeed;
    this._arcballWorldAxis.copy(this._arcballAxis).normalize().applyQuaternion(this.rotation).normalize();
    this._deltaQuat.setFromAxisAngle(this._arcballWorldAxis, -angle);
    this.rotation.premultiply(this._deltaQuat).normalize();
    this._arcballLast.copy(this._arcballEnd);
  }

  _applyDeltas() {
    const panX = this.panVelocity.x;
    const panY = this.panVelocity.y;
    const zoom = this.zoomVelocity;

    if (panX !== 0 || panY !== 0) {
      this._right.set(1, 0, 0).applyQuaternion(this.rotation);
      this._up.set(0, 1, 0).applyQuaternion(this.rotation);
      const scale = this.distance * this.panSpeed;
      this.target.addScaledVector(this._right, -panX * scale);
      this.target.addScaledVector(this._up, panY * scale);
    }

    if (zoom !== 0) {
      this.distance *= 1 + zoom;
    }

    if (this.enableDamping) {
      const decay = Math.max(0, 1 - this.dampingFactor);
      this.panVelocity.multiplyScalar(decay);
      this.zoomVelocity *= decay;
      if (Math.abs(this.zoomVelocity) < 1e-5) {
        this.zoomVelocity = 0;
      }
    } else {
      this.panVelocity.set(0, 0);
      this.zoomVelocity = 0;
    }
  }
}

const controls = new QuaternionOrbitController(camera, renderer.domElement);

function setStatus(message) {
  statusEl.textContent = message;
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
}

window.addEventListener("resize", resize);
resize();

function parseHeader(buffer) {
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
  if (magic !== MAGIC) {
    throw new Error(`Unexpected magic: ${magic}`);
  }
  const view = new DataView(buffer);
  const headerLength = view.getUint32(8, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerLength)));
}

function typedArray(buffer, chunk) {
  const nbytes = chunk.nbytes;
  const offset = chunk.offset;
  if (chunk.dtype === "float32") {
    return new Float32Array(buffer, offset, nbytes / 4);
  }
  if (chunk.dtype === "uint32") {
    return new Uint32Array(buffer, offset, nbytes / 4);
  }
  if (chunk.dtype === "uint8") {
    return new Uint8Array(buffer, offset, nbytes);
  }
  throw new Error(`Unsupported dtype: ${chunk.dtype}`);
}

function makeTexture(buffer, header, name) {
  const chunk = header.chunks[name];
  const shape = chunk.shape;
  const height = shape[0];
  const width = shape[1];
  const channels = shape[2];
  const source = typedArray(buffer, chunk);
  let data = source;
  if (channels !== 4) {
    data = new Uint8Array(width * height * 4);
    const pixelCount = width * height;
    for (let index = 0; index < pixelCount; index += 1) {
      const src = index * channels;
      const dst = index * 4;
      data[dst] = source[src];
      data[dst + 1] = channels > 1 ? source[src + 1] : source[src];
      data[dst + 2] = channels > 2 ? source[src + 2] : 0;
      data[dst + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.internalFormat = "RGBA8";
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

function ensureTextureFits(header) {
  const maxTextureSize = renderer.capabilities.maxTextureSize;
  for (const name of ["pd", "ps", "axay", "normal", "tangent"]) {
    const shape = header.chunks[name].shape;
    if (shape[0] > maxTextureSize || shape[1] > maxTextureSize) {
      throw new Error(
        `${name} texture is ${shape[1]}x${shape[0]}, but this GPU reports max texture size ${maxTextureSize}. ` +
          "Re-export a smaller WebGL package."
      );
    }
  }
}

function prepareProductTexture(texture) {
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createProductMaterial(textures, metadata) {
  const psRange = metadata.encoding.ps.range[1];
  const axRange = metadata.encoding.axay.range;
  return new THREE.ShaderMaterial({
    uniforms: {
      pdTex: { value: prepareProductTexture(textures.pd) },
      psTex: { value: prepareProductTexture(textures.ps) },
      axayTex: { value: prepareProductTexture(textures.axay) },
      normalTex: { value: prepareProductTexture(textures.normal) },
      tangentTex: { value: prepareProductTexture(textures.tangent) },
      mode: { value: Number(modeSelect.value) },
      flipV: { value: flipVInput.checked ? 1 : 0 },
      psRange: { value: psRange },
      axayMin: { value: axRange[0] },
      axayMax: { value: axRange[1] },
      keyLightDir: { value: new THREE.Vector3(0.35, 0.62, 0.7).normalize() },
      lightIntensity: { value: Number(lightIntensityInput.value) },
      headlightRange: { value: Number(headlightRangeInput.value) },
      sceneRadius: { value: sceneRadius },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      varying vec3 vWorldX;
      varying vec3 vWorldY;
      varying vec3 vWorldZ;

      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPos = world.xyz;
        mat3 objectToWorld = mat3(modelMatrix);
        vWorldX = objectToWorld * vec3(1.0, 0.0, 0.0);
        vWorldY = objectToWorld * vec3(0.0, 1.0, 0.0);
        vWorldZ = objectToWorld * vec3(0.0, 0.0, 1.0);
        vNormal = normalize(objectToWorld * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D pdTex;
      uniform sampler2D psTex;
      uniform sampler2D axayTex;
      uniform sampler2D normalTex;
      uniform sampler2D tangentTex;
      uniform int mode;
      uniform int flipV;
      uniform float psRange;
      uniform float axayMin;
      uniform float axayMax;
      uniform vec3 keyLightDir;
      uniform float lightIntensity;
      uniform float headlightRange;
      uniform float sceneRadius;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      varying vec3 vWorldX;
      varying vec3 vWorldY;
      varying vec3 vWorldZ;

      vec2 productUv() {
        return flipV == 1 ? vec2(vUv.x, 1.0 - vUv.y) : vUv;
      }

      vec3 decodeSigned(vec3 value) {
        return value * 2.0 - 1.0;
      }

      float ggxG1Aniso(vec3 value, float ax, float ay) {
        float vz = value.z;
        vec3 scaled = value * vec3(ax, ay, 1.0);
        float g1 = 2.0 * vz / (vz + length(scaled) + 1e-6);
        return vz <= 0.0 ? 0.0 : g1;
      }

      float ggxAniso(vec3 wi, vec3 wo, float ax, float ay) {
        if (wi.z <= 0.0 || wo.z <= 0.0) {
          return 0.0;
        }
        vec3 h = normalize(wi + wo);
        float wiDotH = clamp(dot(wi, h), 0.0, 1.0);
        float fresnel = 0.04 + 0.96 * pow(clamp(1.0 - wiDotH, 0.0, 1.0), 5.0);
        vec3 hScaled = h / vec3(ax + 1e-6, ay + 1e-6, 1.0);
        float len2 = dot(hScaled, hScaled);
        float d = 1.0 / (3.14159265359 * ax * ay * len2 * len2 + 1e-6);
        float g = ggxG1Aniso(wi, ax, ay) * ggxG1Aniso(wo, ax, ay);
        return d * fresnel * g / (4.0 * wi.z * wo.z + 1e-6);
      }

      void main() {
        vec2 uv = productUv();
        vec3 pd = texture2D(pdTex, uv).rgb;
        vec3 ps = texture2D(psTex, uv).rgb * psRange;
        vec2 axayUnit = texture2D(axayTex, uv).rg;
        vec2 axay = mix(vec2(axayMin), vec2(axayMax), axayUnit);
        vec3 normalMap = decodeSigned(texture2D(normalTex, uv).rgb);
        vec3 tangentMap = decodeSigned(texture2D(tangentTex, uv).rgb);

        if (mode == 1) {
          gl_FragColor = vec4(pd, 1.0);
          return;
        }
        if (mode == 2) {
          gl_FragColor = vec4(clamp(ps / max(psRange, 1e-6), 0.0, 1.0), 1.0);
          return;
        }
        if (mode == 3) {
          gl_FragColor = vec4(vec3(axayUnit.r), 1.0);
          return;
        }
        if (mode == 4) {
          gl_FragColor = vec4(vec3(axayUnit.g), 1.0);
          return;
        }
        if (mode == 5) {
          gl_FragColor = vec4(normalMap * 0.5 + 0.5, 1.0);
          return;
        }
        if (mode == 6) {
          gl_FragColor = vec4(tangentMap * 0.5 + 0.5, 1.0);
          return;
        }
        if (mode == 7) {
          gl_FragColor = vec4(fract(vUv), 0.0, 1.0);
          return;
        }

        mat3 objectToWorld = mat3(normalize(vWorldX), normalize(vWorldY), normalize(vWorldZ));
        vec3 n = normalize(objectToWorld * normalize(normalMap));
        if (length(normalMap) < 0.2) {
          n = normalize(vNormal);
        }
        vec3 t = normalize(objectToWorld * normalize(tangentMap));
        t = normalize(t - n * dot(n, t));
        vec3 b = normalize(cross(n, t));
        mat3 worldToLocal = transpose(mat3(t, b, n));
        vec3 cameraToPoint = vWorldPos - cameraPosition;
        vec3 lightWorld = normalize(-cameraToPoint);
        vec3 wi = worldToLocal * lightWorld;
        vec3 wo = worldToLocal * normalize(cameraPosition - vWorldPos);
        if (wo.z < 0.0) {
          n = -n;
          t = -t;
          b = normalize(cross(n, t));
          worldToLocal = transpose(mat3(t, b, n));
          wi = worldToLocal * lightWorld;
          wo = worldToLocal * normalize(cameraPosition - vWorldPos);
        }
        float ndl = max(wi.z, 0.0);
        vec3 beamAxis = normalize(keyLightDir);
        float axisDistance = max(dot(cameraToPoint, beamAxis), 0.0);
        vec3 closestOnAxis = beamAxis * axisDistance;
        float lateralDistance = length(cameraToPoint - closestOnAxis);
        float beamRadius = max(headlightRange * sceneRadius, 1e-4);
        float normalizedLateral = lateralDistance / beamRadius;
        float attenuation = 1.0 / (1.0 + normalizedLateral * normalizedLateral * normalizedLateral * normalizedLateral);
        attenuation = axisDistance > 0.0 ? attenuation : 0.0;
        float brdfSpec = ggxAniso(wi, wo, max(axay.x, 0.006), max(axay.y, 0.006));
        vec3 brdf = pd / 3.14159265359 + ps * brdfSpec;
        vec3 color = brdf * ndl * lightIntensity * attenuation + pd * 0.05;
        gl_FragColor = vec4(pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
      }
    `,
    side: THREE.DoubleSide,
  });
}

function createMaterial(buffer, header) {
  return createProductMaterial(
    {
      pd: makeTexture(buffer, header, "pd"),
      ps: makeTexture(buffer, header, "ps"),
      axay: makeTexture(buffer, header, "axay"),
      normal: makeTexture(buffer, header, "normal"),
      tangent: makeTexture(buffer, header, "tangent"),
    },
    header.metadata
  );
}

function createGeometry(buffer, header) {
  const positions = typedArray(buffer, header.chunks.positions);
  const uvs = typedArray(buffer, header.chunks.uvs);
  const indices = typedArray(buffer, header.chunks.indices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function frameGeometry(geometry) {
  const sphere = geometry.boundingSphere;
  const center = sphere.center;
  const radius = Math.max(sphere.radius, 1e-4);
  sceneRadius = radius;
  controls.minDistance = radius * 0.2;
  controls.maxDistance = radius * 30;
  controls.setView(center, new THREE.Vector3(0, radius * 0.35, radius * 2.5));
  controls.saveState();
  camera.near = radius / 1000;
  camera.far = radius * 1000;
  camera.updateProjectionMatrix();
  controls.update();
  if (material) {
    material.uniforms.sceneRadius.value = sceneRadius;
  }
}

function updateHeadlight() {
  if (!material) {
    return;
  }
  const axis = controls.target.clone().sub(camera.position).normalize();
  material.uniforms.keyLightDir.value.copy(axis);
}

function syncLightingControls() {
  lightIntensityValue.textContent = Number(lightIntensityInput.value).toFixed(2);
  headlightRangeValue.textContent = Number(headlightRangeInput.value).toFixed(2);
  if (!material) {
    return;
  }
  material.uniforms.lightIntensity.value = Number(lightIntensityInput.value);
  material.uniforms.headlightRange.value = Number(headlightRangeInput.value);
}

syncLightingControls();

function readFileWithProgress(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.onprogress = (event) => {
      if (event.lengthComputable) {
        const pct = ((event.loaded / event.total) * 100).toFixed(1);
        setStatus(`Reading ${file.name}: ${pct}% (${(event.loaded / 1e9).toFixed(2)} / ${(event.total / 1e9).toFixed(2)} GB)`);
      } else {
        setStatus(`Reading ${file.name}: ${(event.loaded / 1e9).toFixed(2)} GB`);
      }
    };
    reader.onload = () => resolve(reader.result);
    reader.readAsArrayBuffer(file);
  });
}

async function loadFile(file) {
  setStatus(`Loading ${file.name} ...`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const buffer = await readFileWithProgress(file);
  if (file.name.toLowerCase().endsWith(".glb")) {
    await loadGlb(buffer, file.name);
    return;
  }
  await loadResultBin(buffer, file.name);
}

async function loadResultBin(buffer, fileName) {
  const header = parseHeader(buffer);
  ensureTextureFits(header);
  setStatus(
    `Parsed result.bin. Geometry faces ${header.chunks.indices.shape[0].toLocaleString()}, ` +
      `textures ${header.metadata.texture_width}x${header.metadata.texture_height}. Creating buffers ...`
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  if (productMesh !== null) {
    scene.remove(productMesh);
    productMesh.geometry.dispose();
    productMesh.material.dispose();
  }

  const geometry = createGeometry(buffer, header);
  setStatus("Uploading material textures to GPU ...");
  await new Promise((resolve) => setTimeout(resolve, 20));
  material = createMaterial(buffer, header);
  productMesh = new THREE.Mesh(geometry, material);
  scene.add(productMesh);
  frameGeometry(geometry);
  setStatus(
    `Loaded step ${header.metadata.step}, faces ${header.chunks.indices.shape[0].toLocaleString()}, ` +
      `texture ${header.metadata.texture_width}x${header.metadata.texture_height}.`
  );
}

function parseGlb(buffer) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.parse(buffer, "", resolve, reject);
  });
}

async function loadGlb(buffer, fileName) {
  setStatus(`Parsing ${fileName} ...`);
  const gltf = await parseGlb(buffer);
  const json = gltf.parser.json;
  const product = json.materials?.[0]?.extras?.guoboProduct;
  if (!product) {
    throw new Error("GLB does not contain guoboProduct material extras.");
  }

  const textures = {};
  for (const name of ["pd", "ps", "axay", "normal", "tangent"]) {
    const textureIndex = product.textures[name];
    textures[name] = await gltf.parser.getDependency("texture", textureIndex);
  }

  let loadedMesh = null;
  gltf.scene.traverse((object) => {
    if (loadedMesh === null && object.isMesh) {
      loadedMesh = object;
    }
  });
  if (loadedMesh === null) {
    throw new Error("GLB does not contain a mesh.");
  }

  if (productMesh !== null) {
    scene.remove(productMesh);
    productMesh.geometry.dispose();
    productMesh.material.dispose();
  }

  const geometry = loadedMesh.geometry;
  geometry.computeBoundingSphere();
  material = createProductMaterial(textures, product.metadata);
  productMesh = new THREE.Mesh(geometry, material);
  scene.add(productMesh);
  frameGeometry(geometry);
  setStatus(
    `Loaded GLB step ${product.metadata.step}, faces ${(geometry.index.count / 3).toLocaleString()}, ` +
      `texture ${product.metadata.texture_width}x${product.metadata.texture_height}.`
  );
}

fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) {
    loadFile(file).catch((error) => setStatus(error.message));
  }
});

modeSelect.addEventListener("change", () => {
  if (material) {
    material.uniforms.mode.value = Number(modeSelect.value);
  }
});

flipVInput.addEventListener("change", () => {
  if (material) {
    material.uniforms.flipV.value = flipVInput.checked ? 1 : 0;
  }
});

lightIntensityInput.addEventListener("input", syncLightingControls);
headlightRangeInput.addEventListener("input", syncLightingControls);

window.addEventListener("dragover", (event) => {
  event.preventDefault();
});

window.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    loadFile(file).catch((error) => setStatus(error.message));
  }
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateHeadlight();
  renderer.render(scene, camera);
}

animate();

window.addEventListener("error", (event) => {
  setStatus(`Viewer error: ${event.message}`);
});

window.addEventListener("unhandledrejection", (event) => {
  setStatus(`Viewer error: ${event.reason?.message || event.reason}`);
});
