// Aplica políticas del navegador y evita que el panel se incruste en otros sitios.
export function protegerRespuestaWeb({ cookieSegura = false } = {}) {
  return (solicitud, respuesta, siguiente) => {
    respuesta.set("X-Content-Type-Options", "nosniff");
    respuesta.set("X-DNS-Prefetch-Control", "off");
    respuesta.set("X-Download-Options", "noopen");
    respuesta.set("Referrer-Policy", "no-referrer");
    respuesta.set("X-Frame-Options", "DENY");
    respuesta.set("Content-Security-Policy", [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data:",
      "script-src 'self'",
      "style-src 'self'",
      // xterm genera reglas visuales para el terminal; esta excepción no habilita scripts inline.
      "style-src-elem 'self' 'unsafe-inline'",
      "style-src-attr 'unsafe-inline'",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
    ].join("; "));
    respuesta.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    respuesta.set("Cross-Origin-Opener-Policy", "same-origin");
    respuesta.set("Cross-Origin-Resource-Policy", "same-origin");
    respuesta.set("X-Permitted-Cross-Domain-Policies", "none");
    respuesta.set("Origin-Agent-Cluster", "?1");
    if (solicitud.path.startsWith("/api/")) {
      respuesta.set("Cache-Control", "no-store");
    }
    if (cookieSegura) {
      respuesta.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    siguiente();
  };
}
