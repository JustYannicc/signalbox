import { describe, expect, it } from "vite-plus/test";

import { AVATAR_EXPRESSIONS, AVATAR_EYES, AVATAR_FACES, AVATAR_SHAPES } from "./avatarConfig";
import { facePose, layoutEyes } from "./avatarFaces";
import { BODIES, BODY_RADIUS, LAB_BODIES, LAB_SHAPES } from "./avatarShapes";

describe("avatar geometry", () => {
  it("builds finite body paths that fit the frame", () => {
    for (const shape of AVATAR_SHAPES) {
      const body = BODIES[shape];
      expect(body.d).not.toMatch(/NaN|Infinity/);
      expect(body.top).toBeGreaterThan(5);
      expect(body.bottom).toBeLessThanOrEqual(61);
    }
  });

  it("keeps both eyes visible and inside the body for every face and mood", () => {
    for (const shape of AVATAR_SHAPES) {
      const body = BODIES[shape];
      for (const face of AVATAR_FACES) {
        for (const expression of AVATAR_EXPRESSIONS) {
          for (const tiny of [true, false]) {
            const eyes = layoutEyes(facePose(face, expression), {
              radius: BODY_RADIUS,
              cx: body.faceX,
              cy: body.faceY,
              spread: body.spread,
              tiny,
              style: AVATAR_EYES[0],
            });
            expect(eyes).toHaveLength(2);
            for (const eye of eyes) {
              const [, , , , x, y] = eye.matrix;
              expect(y).toBeGreaterThan(body.top);
              expect(y).toBeLessThan(body.bottom);
              expect(Math.abs(x - 32)).toBeLessThan(BODY_RADIUS);
            }
          }
        }
      }
    }
  });

  it("keeps lab bodies in frame with both eyes inside", () => {
    for (const shape of LAB_SHAPES) {
      const body = LAB_BODIES[shape];
      expect(body.d).not.toMatch(/NaN|Infinity/);
      expect(body.top).toBeGreaterThan(5);
      expect(body.bottom).toBeLessThanOrEqual(61);
      for (const expression of AVATAR_EXPRESSIONS) {
        for (const tiny of [true, false]) {
          const eyes = layoutEyes(facePose("neutral", expression), {
            radius: BODY_RADIUS,
            cx: body.faceX,
            cy: body.faceY,
            spread: body.spread,
            tiny,
            style: "round",
          });
          for (const eye of eyes) {
            const [, , , , x, y] = eye.matrix;
            expect(y).toBeGreaterThan(body.top);
            expect(y).toBeLessThan(body.bottom);
            expect(Math.abs(x - 32)).toBeLessThan(BODY_RADIUS);
          }
        }
      }
    }
  });
});
