#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_DEVICE_NAME 512

static void print_osstatus(const char *label, OSStatus status) {
  char code[5] = {0};
  UInt32 value = CFSwapInt32HostToBig((UInt32)status);
  memcpy(code, &value, 4);

  if (code[0] >= 32 && code[0] <= 126 && code[1] >= 32 && code[1] <= 126 && code[2] >= 32 && code[2] <= 126 && code[3] >= 32 && code[3] <= 126) {
    fprintf(stderr, "SoundBite audio lock: %s failed with OSStatus '%s' (%d)\n", label, code, (int)status);
  } else {
    fprintf(stderr, "SoundBite audio lock: %s failed with OSStatus %d\n", label, (int)status);
  }
}

static UInt32 input_channel_count(AudioDeviceID device_id) {
  AudioObjectPropertyAddress address = {
    kAudioDevicePropertyStreamConfiguration,
    kAudioDevicePropertyScopeInput,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  OSStatus status = AudioObjectGetPropertyDataSize(device_id, &address, 0, NULL, &size);
  if (status != noErr || size == 0) {
    return 0;
  }

  AudioBufferList *buffer_list = (AudioBufferList *)calloc(1, size);
  if (!buffer_list) {
    return 0;
  }

  status = AudioObjectGetPropertyData(device_id, &address, 0, NULL, &size, buffer_list);
  if (status != noErr) {
    free(buffer_list);
    return 0;
  }

  UInt32 channels = 0;
  for (UInt32 i = 0; i < buffer_list->mNumberBuffers; i += 1) {
    channels += buffer_list->mBuffers[i].mNumberChannels;
  }

  free(buffer_list);
  return channels;
}

static int device_name(AudioDeviceID device_id, char *buffer, size_t buffer_size) {
  AudioObjectPropertyAddress address = {
    kAudioObjectPropertyName,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  CFStringRef name = NULL;
  UInt32 size = sizeof(name);
  OSStatus status = AudioObjectGetPropertyData(device_id, &address, 0, NULL, &size, &name);

  if (status != noErr || !name) {
    return 0;
  }

  int ok = CFStringGetCString(name, buffer, buffer_size, kCFStringEncodingUTF8);
  CFRelease(name);
  return ok;
}

static int hog_owner(AudioDeviceID device_id, pid_t *owner) {
  AudioObjectPropertyAddress address = {
    kAudioDevicePropertyHogMode,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = sizeof(*owner);
  OSStatus status = AudioObjectGetPropertyData(device_id, &address, 0, NULL, &size, owner);

  if (status != noErr) {
    return 0;
  }

  return 1;
}

static int acquire_hog_mode(AudioDeviceID device_id, const char *device_name_label) {
  AudioObjectPropertyAddress address = {
    kAudioDevicePropertyHogMode,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  Boolean settable = false;
  OSStatus status = AudioObjectIsPropertySettable(device_id, &address, &settable);
  if (status != noErr || !settable) {
    return 0;
  }

  pid_t before = -1;
  if (hog_owner(device_id, &before) && before != -1 && before != getpid()) {
    fprintf(stderr, "SoundBite audio lock: %s is already hogged by pid %d\n", device_name_label, before);
    return 0;
  }

  pid_t owner = -1;
  UInt32 size = sizeof(owner);
  status = AudioObjectSetPropertyData(device_id, &address, 0, NULL, size, &owner);
  if (status != noErr) {
    print_osstatus("AudioObjectSetPropertyData(kAudioDevicePropertyHogMode)", status);
    return 0;
  }

  if (owner != getpid()) {
    fprintf(stderr, "SoundBite audio lock: %s hog owner is pid %d, expected pid %d\n", device_name_label, owner, getpid());
    return 0;
  }

  return 1;
}

static int matching_device(AudioDeviceID device_id, const char *target_name, char *name_buffer, size_t name_buffer_size) {
  if (input_channel_count(device_id) == 0) {
    return 0;
  }

  if (!device_name(device_id, name_buffer, name_buffer_size)) {
    return 0;
  }

  return strcmp(name_buffer, target_name) == 0;
}

static int acquire_matching_device(const char *target_name, int target_occurrence) {
  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyDevices,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  OSStatus status = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size);
  if (status != noErr || size == 0) {
    print_osstatus("AudioObjectGetPropertyDataSize(kAudioHardwarePropertyDevices)", status);
    return 0;
  }

  AudioDeviceID *devices = (AudioDeviceID *)calloc(1, size);
  if (!devices) {
    fprintf(stderr, "SoundBite audio lock: failed to allocate device list\n");
    return 0;
  }

  status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, devices);
  if (status != noErr) {
    print_osstatus("AudioObjectGetPropertyData(kAudioHardwarePropertyDevices)", status);
    free(devices);
    return 0;
  }

  UInt32 count = size / sizeof(AudioDeviceID);
  int occurrence = 0;
  AudioDeviceID first_tried = kAudioObjectUnknown;
  char name[MAX_DEVICE_NAME];

  for (UInt32 i = 0; i < count; i += 1) {
    if (!matching_device(devices[i], target_name, name, sizeof(name))) {
      continue;
    }

    occurrence += 1;
    if (occurrence != target_occurrence) {
      continue;
    }

    first_tried = devices[i];
    if (acquire_hog_mode(devices[i], name)) {
      fprintf(stderr, "SoundBite audio lock: acquired Core Audio hog mode for %s occurrence %d with pid %d\n", name, occurrence, getpid());
      free(devices);
      return 1;
    }
  }

  for (UInt32 i = 0; i < count; i += 1) {
    if (devices[i] == first_tried) {
      continue;
    }

    if (!matching_device(devices[i], target_name, name, sizeof(name))) {
      continue;
    }

    if (acquire_hog_mode(devices[i], name)) {
      fprintf(stderr, "SoundBite audio lock: acquired Core Audio hog mode for %s with pid %d\n", name, getpid());
      free(devices);
      return 1;
    }
  }

  fprintf(stderr, "SoundBite audio lock: no available Core Audio input matched %s occurrence %d\n", target_name, target_occurrence);
  free(devices);
  return 0;
}

static void usage(void) {
  fprintf(stderr, "usage: macos-audio-hog-wrapper --device-name NAME [--device-occurrence N] -- ffmpeg [args...]\n");
}

int main(int argc, char **argv) {
  const char *device_name_arg = NULL;
  int device_occurrence = 1;
  int exec_index = -1;

  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--device-name") == 0 && i + 1 < argc) {
      device_name_arg = argv[++i];
      continue;
    }

    if (strcmp(argv[i], "--device-occurrence") == 0 && i + 1 < argc) {
      device_occurrence = atoi(argv[++i]);
      if (device_occurrence < 1) {
        device_occurrence = 1;
      }
      continue;
    }

    if (strcmp(argv[i], "--") == 0) {
      exec_index = i + 1;
      break;
    }
  }

  if (!device_name_arg || exec_index <= 0 || exec_index >= argc) {
    usage();
    return 64;
  }

  if (!acquire_matching_device(device_name_arg, device_occurrence)) {
    return 72;
  }

  execvp(argv[exec_index], &argv[exec_index]);
  fprintf(stderr, "SoundBite audio lock: failed to exec %s: %s\n", argv[exec_index], strerror(errno));
  return 127;
}
