// The CRM's pure rules: no imports from outside this folder, no translations, no clock (functions
// that need "now" take it as an argument). The app mirrors this folder to give instant hints;
// the server runs the same functions and has the last word. Edit only this copy.
export * from "./lists.js";
export * from "./fields.js";
export * from "./phone.js";
