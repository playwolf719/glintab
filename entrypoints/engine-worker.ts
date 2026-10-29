import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { startEngineWorker } from '../lib/engine/engine.worker';

// Bundle this as an extension-owned script in both serve and build modes.
// A Vite URL derived from import.meta.url belongs to the HTTP dev server;
// extension workers must never depend on that remote module URL.
export default defineUnlistedScript(() => startEngineWorker());
