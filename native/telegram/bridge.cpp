// Minimal process transport for Telegram's official TDLib JSON/C interface.
// The protocol implementation and session database belong entirely to TDLib.
#include <csignal>
#include <cstring>
#include <dlfcn.h>
#include <iostream>
#include <poll.h>
#include <string>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>
static volatile std::sig_atomic_t running = 1;
static void stop(int) { running = 0; }
int main(int argc, char **argv) {
  umask(0077);
  struct rlimit limit{0, 0}; setrlimit(RLIMIT_CORE, &limit);
  if (argc != 2) { std::cerr << "TDLIB_LIBRARY_REQUIRED\n"; return 2; }
  void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!library) { std::cerr << "TDLIB_LIBRARY_UNAVAILABLE\n"; return 2; }
  auto create = reinterpret_cast<int(*)()>(dlsym(library,"td_create_client_id"));
  auto send = reinterpret_cast<void(*)(int,const char*)>(dlsym(library,"td_send"));
  auto receive = reinterpret_cast<const char*(*)(double)>(dlsym(library,"td_receive"));
  auto execute = reinterpret_cast<const char*(*)(const char*)>(dlsym(library,"td_execute"));
  if (!create || !send || !receive || !execute) { std::cerr << "TDLIB_ABI_UNSUPPORTED\n"; return 2; }
  execute("{\"@type\":\"setLogVerbosityLevel\",\"new_verbosity_level\":0}");
  execute("{\"@type\":\"setLogStream\",\"log_stream\":{\"@type\":\"logStreamEmpty\"}}");
  std::signal(SIGTERM,stop); std::signal(SIGINT,stop); std::signal(SIGPIPE,SIG_IGN);
  const int id = create();
  std::cout << "{\"@type\":\"easychatBridgeReady\",\"protocol\":1}" << std::endl;
  send(id,"{\"@type\":\"getAuthorizationState\"}");
  std::string input;
  while (running) {
    struct pollfd fd{STDIN_FILENO, POLLIN, 0};
    if (poll(&fd,1,20)>0 && (fd.revents & (POLLIN|POLLHUP))) {
      char bytes[4096]; const auto length=read(STDIN_FILENO,bytes,sizeof(bytes));
      if (length<=0) { running=0; break; }
      input.append(bytes,static_cast<size_t>(length));
      if (input.size()>131072) { running=0; break; }
      size_t end;
      while ((end=input.find('\n'))!=std::string::npos) {
        const auto line=input.substr(0,end); input.erase(0,end+1);
        if (!line.empty()) send(id,line.c_str());
      }
    }
    for (int i=0;i<256;i++) {
      const char *update=receive(0);
      if (!update) break;
      const bool closed=std::strstr(update,"\"@type\":\"authorizationStateClosed\"")!=nullptr;
      std::cout << update << std::endl;
      if (closed) return 0;
    }
  }
  send(id,"{\"@type\":\"close\"}");
  for (int i=0;i<50;i++) {
    const char *update=receive(0.1);
    if (!update) continue;
    const bool closed=std::strstr(update,"\"@type\":\"authorizationStateClosed\"")!=nullptr;
    std::cout << update << std::endl;
    if (closed) break;
  }
  return 0;
}
