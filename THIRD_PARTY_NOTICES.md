# Third-party source and artwork notices

## User-supplied shader reference

- Reference URL: https://www.shadertoy.com/view/WlcfRn
- Supplied in this project brief on 2026-10-02
- License designation supplied by the user: MIT
- Original author and copyright notice: not supplied

The supplied GLSL is retained in `homepage/src/respire/WlcfRn-user-supplied.glsl`. The renderer uses the supplied example as a reference for custom material/shading techniques. Its eight-cylinder/toroidal `sdPlant` demonstration is not the current geometry; the visual reference drives an independently modeled layered mesh and fine filament ribbons with slow GPU vertex deformation. This project does not invent an original author or independently certify the upstream license. Preserve the original author/copyright notice with the MIT license when that information is provided for production distribution.

## Reference artwork

`homepage/assets/memory-fiber-sculpture.png` is a byte-for-byte copy of the original 1254×1254 visual reference supplied by the user. It is both the WebGL-independent artwork fallback and the full-resolution sRGB material projected onto actual deforming folded 3D meshes. Rest-space UVs move the image detail with each sheet. Additional traced structural strands and the separate red tube are actual geometry; the photographic hairlines are not all individually modeled. The shader excludes the source’s red path from the material and masks photographed ground shadow outside the fiber silhouette. The original reference remains unchanged. This artwork is unrelated to customer memory content, and no customer images or records are included.

## Dependencies

Third-party packages remain under their respective licenses. Exact dependency versions are recorded in `package-lock.json`.

The retained Shadcn Tailwind stylesheet license is in `homepage/vendor/shadcn-tailwind-4.13.0.LICENSE.md`.
