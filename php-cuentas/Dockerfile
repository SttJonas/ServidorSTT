FROM php:8.3-apache-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsqlite3-dev libonig-dev \
    && docker-php-ext-install mbstring pdo_sqlite \
    && rm -rf /var/lib/apt/lists/* \
    && a2dismod -f status autoindex \
    && mkdir -p /var/lib/swatt-cuentas \
    && sed -i 's/Listen 80/Listen 8080/' /etc/apache2/ports.conf \
    && sed -i 's/:80>/:8080>/' /etc/apache2/sites-enabled/000-default.conf \
    && sed -i 's#ErrorLog \${APACHE_LOG_DIR}/error.log#ErrorLog /proc/self/fd/2#; s#CustomLog \${APACHE_LOG_DIR}/access.log combined#CustomLog /proc/self/fd/1 combined#' /etc/apache2/sites-enabled/000-default.conf \
    && sed -i 's#APACHE_RUN_DIR=/var/run/apache2#APACHE_RUN_DIR=/tmp/apache2#' /etc/apache2/envvars \
    && sed -i 's#APACHE_PID_FILE=/var/run/apache2/apache2.pid#APACHE_PID_FILE=/tmp/apache2/apache2.pid#' /etc/apache2/envvars \
    && sed -i 's#APACHE_LOCK_DIR=/var/lock/apache2#APACHE_LOCK_DIR=/tmp/apache2#' /etc/apache2/envvars \
    && printf '%s\n' 'StartServers 1' 'MinSpareServers 1' 'MaxSpareServers 4' 'ServerLimit 4' 'MaxRequestWorkers 4' 'MaxConnectionsPerChild 500' > /etc/apache2/mods-available/mpm_prefork.conf \
    && mkdir -p /tmp/apache2 \
    && chown -R www-data:www-data /var/lib/swatt-cuentas /tmp/apache2 \
    && chmod 0700 /var/lib/swatt-cuentas

RUN printf '%s\n' '<Directory /var/www/html>' '    FallbackResource /index.php' '</Directory>' >> /etc/apache2/apache2.conf

# Mantiene los archivos de ejecución de Apache en el tmpfs del contenedor.
ENV APACHE_RUN_DIR=/tmp/apache2 \
    APACHE_PID_FILE=/tmp/apache2/apache2.pid \
    APACHE_LOCK_DIR=/tmp/apache2

COPY php.ini /usr/local/etc/php/conf.d/seguridad.ini
COPY index.php /var/www/html/index.php

WORKDIR /var/www/html
USER www-data

EXPOSE 8080
