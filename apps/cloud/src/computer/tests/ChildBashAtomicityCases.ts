const barrier = (size: number, body: (payload: string) => string) =>
  `printf -v A '%0*d' ${size} 0; printf -v B '%*s' ${size} ''; coproc FEED { while read -r l; do echo "$l"; done; }; exec 5<&\${FEED[0]} 6>&\${FEED[1]}; ` +
  `( read -r _ <&5; ${body("$A")} ) & ( read -r _ <&5; ${body("$B")} ) & echo go >&6; echo go >&6; exec 6>&- 5<&-; eval "exec \${FEED[1]}>&-"; wait; echo ok`;

export const bashAtomicityWriters = [
  {
    label: "O_APPEND",
    path: "/workspace/append.log",
    script: (size: number) =>
      barrier(size, (payload) => `echo -n "${payload}" >> /workspace/append.log`),
  },
  {
    label: "shared open offset",
    path: "/workspace/shared-offset.log",
    script: (size: number) =>
      `exec 7>/workspace/shared-offset.log; ${barrier(size, (payload) => `echo -n "${payload}" >&7`)}`,
  },
] as const;
