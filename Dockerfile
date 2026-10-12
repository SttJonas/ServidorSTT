# Usa Node.js 22 LTS en una imagen pequeña de Debian.
FROM node:22-bookworm-slim

# Define el directorio de trabajo dentro del contenedor.
WORKDIR /app

# Instala Git solo para importar repositorios públicos mediante HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copia primero la manifestación para aprovechar la caché de Docker.
COPY --chown=node:node package*.json ./

# Instala las versiones exactas del lockfile y omite dependencias de desarrollo.
RUN npm ci --omit=dev

# Copia el código fuente y la configuración del proyecto.
COPY --chown=node:node configuracion ./configuracion
COPY --chown=node:node src ./src
COPY --chown=node:node publico ./publico

# Prepara el área persistente de proyectos para el usuario sin privilegios.
RUN mkdir -p /app/proyectos /var/lib/swatt-panel \
    && chown node:node /app/proyectos /var/lib/swatt-panel

# Ejecuta el servidor con el usuario sin privilegios incluido en la imagen.
USER node

# Documenta el puerto HTTP utilizado por el servicio.
EXPOSE 3000

# Arranca el punto de entrada del backend.
CMD ["npm", "run", "inicio"]
