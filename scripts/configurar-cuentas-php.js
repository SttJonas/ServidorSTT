// Añade una clave aleatoria para autenticar las llamadas internas a PHP.
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const archivo = resolve(process.cwd(), ".env");
let contenido;

try {
  contenido = readFileSync(archivo, "utf8");
} catch (error) {
  if (error.code === "ENOENT") {
    throw new Error("No existe .env. Configura primero el acceso con npm run configurar-acceso.");
  }
  throw error;
}

const entradas = [...contenido.matchAll(/^CUENTAS_API_SECRETO=(.*)$/gm)];
if (entradas.length > 1) {
  throw new Error("Hay más de una entrada CUENTAS_API_SECRETO en .env; resuélvelas manualmente.");
}
const existente = entradas[0];
if (existente) {
  if (!/^[a-f0-9]{64}$/.test(existente[1])) {
    throw new Error("CUENTAS_API_SECRETO ya existe, pero no tiene 64 caracteres hexadecimales; revísalo manualmente.");
  }
  console.log("CUENTAS_API_SECRETO ya está configurado; no se modificó .env.");
} else {
  const separador = contenido.endsWith("\n") ? "" : "\n";
  const actualizado = `${contenido}${separador}CUENTAS_API_SECRETO=${randomBytes(32).toString("hex")}\n`;
  const temporal = `${archivo}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporal, actualizado, { flag: "wx", mode: 0o600 });
    renameSync(temporal, archivo);
  } catch (error) {
    try {
      unlinkSync(temporal);
    } catch {}
    throw error;
  }
  try {
    chmodSync(archivo, 0o600);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
  }
  console.log("Se añadió CUENTAS_API_SECRETO a .env. No compartas ni publiques ese archivo.");
}
