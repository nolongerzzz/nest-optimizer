export function createThreeHostAdapter({ THREE, scene, camera, raycastables, markerColor = 0xe8a33d }) {
  const raycaster = new THREE.Raycaster();
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 16, 16),
    new THREE.MeshBasicMaterial({ color: markerColor })
  );
  marker.visible = false;
  scene.add(marker);

  function placeMarker(target) {
    if (!target) { marker.visible = false; return; }
    if (target.worldPoint) {
      marker.position.set(target.worldPoint[0], target.worldPoint[1], target.worldPoint[2]);
      marker.visible = true;
    }
  }
  function clearMarker() { marker.visible = false; }

  function liveList() {
    if (typeof raycastables === 'function') return raycastables() || [];
    return raycastables || [];
  }

  function catalogName(mesh) {
    const raw = mesh && mesh.name ? String(mesh.name) : '';
    const st = typeof window !== 'undefined' ? window.state : null;
    if (st && st.models && raw.indexOf('m-') === 0) {
      const id = Number(raw.slice(2));
      const m = st.models.find(function (x) { return x && x.id === id; });
      if (m && m.name) return String(m.name).replace(/\.stl$/i, '');
    }
    return raw;
  }

  function raycastAtScreenPoint(point) {
    camera.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    raycaster.setFromCamera(new THREE.Vector2(point.xNDC, point.yNDC), camera);
    const hits = raycaster.intersectObjects(liveList(), false);
    if (!hits.length) return { hit: false };
    const h = hits[0];
    return {
      hit: true,
      objectId: catalogName(h.object),
      point: { x: +h.point.x.toFixed(4), y: +h.point.y.toFixed(4), z: +h.point.z.toFixed(4) },
      normal: h.face ? { x: +h.face.normal.x.toFixed(3), y: +h.face.normal.y.toFixed(3), z: +h.face.normal.z.toFixed(3) } : null,
      distance: +h.distance.toFixed(4),
    };
  }

  function getCameraState() {
    return {
      position: { x: +camera.position.x.toFixed(3), y: +camera.position.y.toFixed(3), z: +camera.position.z.toFixed(3) },
      quaternion: { x: +camera.quaternion.x.toFixed(4), y: +camera.quaternion.y.toFixed(4), z: +camera.quaternion.z.toFixed(4), w: +camera.quaternion.w.toFixed(4) },
      fov: camera.fov, aspect: camera.aspect, zoom: camera.zoom,
    };
  }

  function setCameraState(s) {
    if (!s) return;
    if (s.position) camera.position.set(s.position.x, s.position.y, s.position.z);
    if (s.quaternion) camera.quaternion.set(s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w);
    if (typeof s.fov === 'number') camera.fov = s.fov;
    if (typeof s.aspect === 'number') camera.aspect = s.aspect;
    if (typeof s.zoom === 'number') camera.zoom = s.zoom;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  if (typeof window !== 'undefined') {
    window.__CTH_HOST__ = { getCameraState, setCameraState, raycastAtScreenPoint };
  }

  return { placeMarker, clearMarker, raycastAtScreenPoint, getCameraState, setCameraState, marker };
}
