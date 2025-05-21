FROM mcr.microsoft.com/devcontainers/base:ubuntu

RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends nodejs npm ffmpeg \
    python3 python3-pip python3-dev portaudio19-dev libasound2-dev \
    && pip3 install --upgrade pip \
    && pip3 install discord.py aiavatar sounddevice numpy soundfile python-dotenv