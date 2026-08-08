#pragma once

#include <cstddef>
#include <cstdint>

extern "C" {

typedef bool (*retro_environment_t)(unsigned, void *);
typedef void (*retro_video_refresh_t)(const void *, unsigned, unsigned, std::size_t);
typedef void (*retro_audio_sample_t)(int16_t, int16_t);
typedef std::size_t (*retro_audio_sample_batch_t)(const int16_t *, std::size_t);
typedef void (*retro_input_poll_t)();
typedef int16_t (*retro_input_state_t)(unsigned, unsigned, unsigned, unsigned);
typedef void (*retro_log_printf_t)(int, const char *, ...);

enum retro_pixel_format { RETRO_PIXEL_FORMAT_0RGB1555 = 0, RETRO_PIXEL_FORMAT_XRGB8888 = 1, RETRO_PIXEL_FORMAT_RGB565 = 2 };
enum retro_device { RETRO_DEVICE_NONE = 0, RETRO_DEVICE_JOYPAD = 1 };
enum retro_device_id { RETRO_DEVICE_ID_JOYPAD_B = 0, RETRO_DEVICE_ID_JOYPAD_Y = 1, RETRO_DEVICE_ID_JOYPAD_SELECT = 2, RETRO_DEVICE_ID_JOYPAD_START = 3, RETRO_DEVICE_ID_JOYPAD_UP = 4, RETRO_DEVICE_ID_JOYPAD_DOWN = 5, RETRO_DEVICE_ID_JOYPAD_LEFT = 6, RETRO_DEVICE_ID_JOYPAD_RIGHT = 7, RETRO_DEVICE_ID_JOYPAD_A = 8, RETRO_DEVICE_ID_JOYPAD_X = 9 };
enum retro_log_level { RETRO_LOG_DEBUG = 0, RETRO_LOG_INFO = 1, RETRO_LOG_WARN = 2, RETRO_LOG_ERROR = 3 };

enum retro_environment_cmd { RETRO_ENVIRONMENT_SET_PIXEL_FORMAT = 10, RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME = 18, RETRO_ENVIRONMENT_GET_LOG_INTERFACE = 27, RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO = 32 };

struct retro_game_geometry { unsigned base_width; unsigned base_height; unsigned max_width; unsigned max_height; float aspect_ratio; };
struct retro_system_timing { double fps; double sample_rate; };
struct retro_system_av_info { retro_game_geometry geometry; retro_system_timing timing; };
struct retro_game_info { const char *path; const void *data; std::size_t size; const char *meta; };
struct retro_system_info { const char *library_name; const char *library_version; const char *valid_extensions; bool need_fullpath; bool block_extract; };
struct retro_log_callback { retro_log_printf_t log; };

using retro_init_t = void (*)();
using retro_deinit_t = void (*)();
using retro_api_version_t = unsigned (*)();
using retro_get_system_info_t = void (*)(retro_system_info *);
using retro_get_system_av_info_t = void (*)(retro_system_av_info *);
using retro_set_environment_t = void (*)(retro_environment_t);
using retro_set_video_refresh_t = void (*)(retro_video_refresh_t);
using retro_set_audio_sample_t = void (*)(retro_audio_sample_t);
using retro_set_audio_sample_batch_t = void (*)(retro_audio_sample_batch_t);
using retro_set_input_poll_t = void (*)(retro_input_poll_t);
using retro_set_input_state_t = void (*)(retro_input_state_t);
using retro_load_game_t = bool (*)(const retro_game_info *);
using retro_unload_game_t = void (*)();
using retro_run_t = void (*)();

}
