// Release tag baked into the image at build time (release.yaml); "dev" for local builds.
export const APP_VERSION = process.env.APP_VERSION?.trim() || "dev";
