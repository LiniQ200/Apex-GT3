// The Concept donor contains material variants, tangents, UVs and embedded
// photographs. studio.ts authors its own materials and UVs. Keep the exact
// indexed triangles, normals, node hierarchy and attribution it actually uses.
export function rigGlb(input) {
  const jsonSize = input.readUInt32LE(12), g = JSON.parse(input.toString('utf8', 20, 20 + jsonSize));
  if (g.extensionsUsed?.includes('KHR_draco_mesh_compression')) return input; // offline 458 donor
  const bin = input.subarray(28 + jsonSize), accessors = [], bufferViews = [], chunks = [];
  const accessorIds = new Map(), viewIds = new Map();
  let length = 0;
  function keep(id) {
    if (accessorIds.has(id)) return accessorIds.get(id);
    const accessor = g.accessors[id], vi = accessor.bufferView;
    if (!viewIds.has(vi)) {
      const view = g.bufferViews[vi], start = view.byteOffset || 0;
      viewIds.set(vi, bufferViews.length);
      bufferViews.push({ ...view, byteOffset: length });
      const padding = -view.byteLength & 3;
      chunks.push(bin.subarray(start, start + view.byteLength), Buffer.alloc(padding));
      length += view.byteLength + padding;
    }
    const index = accessors.length;
    accessorIds.set(id, index);
    accessors.push({ ...accessor, bufferView: viewIds.get(vi) });
    return index;
  }
  const meshes = g.meshes.map(m => ({ ...m, primitives: m.primitives.map(p => ({
    mode: p.mode, indices: keep(p.indices), attributes: { POSITION: keep(p.attributes.POSITION), NORMAL: keep(p.attributes.NORMAL) },
  })) }));
  const json = Buffer.from(JSON.stringify({ asset: g.asset, scene: g.scene, scenes: g.scenes, nodes: g.nodes,
    meshes, accessors, bufferViews, buffers: [{ byteLength: length }] }));
  const padding = Buffer.alloc(-json.length & 3, 0x20), head = Buffer.from(input.subarray(0, 20));
  head.writeUInt32LE(28 + json.length + padding.length + length, 8);
  head.writeUInt32LE(json.length + padding.length, 12);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(length); binaryHeader.write('BIN\0', 4, 'ascii');
  return Buffer.concat([head, json, padding, binaryHeader, ...chunks]);
}
