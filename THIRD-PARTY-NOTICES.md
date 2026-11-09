# 第三方资源与归属声明

本项目代码采用 MIT。以下资源遵循各自许可证：

### Human cortical surface and derived surface filaments

- Original author: **Anderson Winkler**
- Original work: [Brain for Blender](https://brainder.org/research/brain-for-blender/)
- Source archive: https://s3.us-east-2.amazonaws.com/brainder/software/brain4blender/smallfiles/pial_Full_obj.tar.bz2
- License: [Creative Commons Attribution-ShareAlike 3.0 Unported](https://creativecommons.org/licenses/by-sa/3.0/)

Changes: converted Wavefront OBJ meshes to indexed binary positions and faces,
centered coordinates and uniformly scaled them to 3.65 units; generated
decorative surface-following filaments from mesh edges; generated smoothed
hologram strands from mesh adjacency; applied artistic display transforms,
shaders, and colors. Memory placement and decorative strands are artistic,
not anatomical or scientific connections. No endorsement by the original
author is implied.

This notice applies to `web/assets/cortex/lh.bin`, `rh.bin`,
`lh.fibers.bin`, `rh.fibers.bin`, `lh.hologram.bin`, `rh.hologram.bin`,
and derived cortical geometry, plus their metadata files. The full notice
ships in the package as `web/assets/cortex/LICENSE-ATTRIBUTION.md`,
`web/assets/cortex/metadata.json`, `web/assets/cortex/hologram-metadata.json`,
and `web/assets/CORTEX-LICENSE-ATTRIBUTION.md`.

### Three.js

`web/assets/three/` is a subset of [three.js](https://threejs.org/),
distributed under the MIT license. The upstream license text is kept with
the vendored files.

### Other bundled files

`web/assets/DAFEIYU-LICENSE.txt` carries the project-level MIT notice for
the visualization app.
