// Lee exclusivamente el informe de métricas producido por el agente del host.
import { readFile } from "node:fs/promises";

const archivoEstado = "/run/swatt-monitor/estado.json";

// Devuelve métricas del Debian real sin montar el socket Docker en el panel.
export async function obtenerEstadoSistema() {
  try {
    const contenido = await readFile(archivoEstado, "utf8");
    const estado = JSON.parse(contenido);
    const edadInforme = Date.now() - Date.parse(estado.momento);
    if (!estado.hostname || !estado.cpu || !estado.memoria || !estado.disco || !Number.isFinite(edadInforme)) {
      throw new Error("El informe del agente no contiene los campos requeridos.");
    }
    if (edadInforme > 15000 || edadInforme < -30000) {
      throw new Error("El informe del agente está desactualizado.");
    }
    return estado;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("El agente de métricas del host todavía no está instalado.");
    }
    throw error;
  }
}
