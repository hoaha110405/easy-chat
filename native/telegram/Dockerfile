FROM debian:bookworm-slim AS tdlib-native
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl cmake g++ make gperf libssl-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build/easychat
COPY native/telegram/bridge.cpp native/telegram/CMakeLists.txt native/telegram/build-tdlib.sh native/telegram/
RUN TDLIB_INSTALL_PREFIX=/opt/tdlib bash native/telegram/build-tdlib.sh \
    && mkdir -p /opt/easychat-native/bin \
    && cp native/telegram/build/tdjson-bridge /opt/easychat-native/bin/
# Copy these artifacts into a glibc-compatible Debian runtime with libssl3,
# zlib1g and libstdc++6. This is an artifact image, not another chat service.
FROM scratch AS artifacts
COPY --from=tdlib-native /opt/tdlib /opt/tdlib
COPY --from=tdlib-native /opt/easychat-native /opt/easychat-native
