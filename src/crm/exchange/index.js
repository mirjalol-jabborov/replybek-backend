// Exchange: the workspace's data in and out of Excel. A module of the host (see ../modules.js)
// with routes only: it owns no snapshot keys. Its writes (an applied import) answer with changes
// like every CRM write, through db.js write().
export { router } from "./routes.js";
export const keys = [];
export async function snapshot() {
  return {};
}
