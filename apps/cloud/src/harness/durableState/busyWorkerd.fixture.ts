export default {
  fetch(_request: Request): Response {
    const iterations = 100_000_000;
    let checksum = 0;
    for (let index = 0; index < iterations; index++) {
      checksum = (checksum + ((index * 31) ^ (index >>> 2))) | 0;
    }
    return Response.json({ iterations, checksum });
  },
};
