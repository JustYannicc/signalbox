// Delete this hook and enable addMissingPeerTypes when upgrading to pnpm 12.
module.exports = {
  hooks: {
    readPackage(pkg) {
      for (const name of ["react", "react-dom"]) {
        const types = `@types/${name}`;
        if (
          pkg.peerDependencies?.[name] &&
          !pkg.peerDependencies[types] &&
          !pkg.dependencies?.[types]
        ) {
          pkg.peerDependencies[types] = "*";
          pkg.peerDependenciesMeta ??= {};
          pkg.peerDependenciesMeta[types] = { optional: true };
        }
      }
      return pkg;
    },
  },
};
