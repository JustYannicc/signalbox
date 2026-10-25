// Fixed identity digests keep private sandbox IDs out of the repository.
// Recognition survives disabled or missing test configuration, so routing fails closed.
export const E2E_USER_ID_HASHES: ReadonlySet<string> = new Set([
  "7dc3de9899f7a9542d5d899ae87bcf0936bd43db2d11311dc16a218d5f9f3d50",
  "900f565194fe6ce970d60586f55617efaaa198dc170e57ea783dcd5566a34332",
  "5c64e9dc65b935cb1a446850e8e0bc8443e675aa6cf2933acc0ff725c9361b03",
  "82ad0e361c2a700d4c11c4942c1159f6536677ac21bda3b3dacdbd5f32c33ad3",
  "e1f89fd1f311492800abfb3bbdb4ac593a9634ce6916a782afcbcf64c8ab32de",
  "583bbab0a41499bea6c4e95e912340083817c3b162f98d7f7b3877b9b70f3408",
  "24ce3e67ff33b7423c6d43227b26cddc114024224992144ff74148a40ff3c73b",
  "5383a3a2608133efa2b1094210b18f16f8c7d51e6c3978d0ce773b7442b4deec",
  "482e95c7a2c0c4ab226140d96cb734d517ca9ca14925f467e5fc27b160764582",
]);
