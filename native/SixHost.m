#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <signal.h>
#include <unistd.h>

static volatile sig_atomic_t ownedBackendPid = 0;
static void stopHost(int signalNumber) {
    if (ownedBackendPid > 0) kill(ownedBackendPid, SIGTERM);
    _exit(0);
}

@interface SixHost : NSObject <NSApplicationDelegate>
@property (strong) NSPanel *panel;
@property (strong) WKWebView *web;
@property (assign) BOOL pageLoaded;
@property (strong) NSTask *backend;
@property (copy) NSString *rootPath;
@property (copy) NSString *nodePath;
@property (assign) BOOL checkingBackend;
@property (copy) NSString *pendingBundle;
@property (copy) NSString *lastSentBundle;
@property (strong) NSTimer *retryTimer;
@end

@implementation SixHost

- (NSURL *)endpoint:(NSString *)path {
    return [NSURL URLWithString:[@"http://127.0.0.1:5173/" stringByAppendingString:path]];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    fprintf(stderr, "SIX host did finish launching\n");
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSArray<NSString *> *args = NSProcessInfo.processInfo.arguments;
    NSUInteger rootIndex = [args indexOfObject:@"--root"];
    NSUInteger nodeIndex = [args indexOfObject:@"--node"];
    if (rootIndex == NSNotFound || nodeIndex == NSNotFound || rootIndex + 1 >= args.count || nodeIndex + 1 >= args.count) {
        fprintf(stderr, "SixHost requires --root and --node arguments.\n");
        [NSApp terminate:nil]; return;
    }
    self.rootPath = args[rootIndex + 1];
    self.nodePath = args[nodeIndex + 1];
    [self ensureBackend];
    [self showMonitor];
    self.pendingBundle = NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier ?: @"com.apple.finder";
    [NSWorkspace.sharedWorkspace.notificationCenter addObserver:self selector:@selector(appActivated:) name:NSWorkspaceDidActivateApplicationNotification object:nil];
    self.retryTimer = [NSTimer scheduledTimerWithTimeInterval:1 target:self selector:@selector(sendForeground) userInfo:nil repeats:YES];
    [self sendForeground];
}

- (void)ensureBackend {
    if (self.checkingBackend) return;
    self.checkingBackend = YES;
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[self endpoint:@"api/health"]];
    request.timeoutInterval = 1;
    [[NSURLSession.sharedSession dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            self.checkingBackend = NO;
            if ([response isKindOfClass:NSHTTPURLResponse.class] && ((NSHTTPURLResponse *)response).statusCode == 200) return;
            if (self.backend.isRunning) return;
            NSTask *task = [NSTask new];
            task.executableURL = [NSURL fileURLWithPath:self.nodePath];
            task.arguments = @[@"server/index.js"];
            task.currentDirectoryURL = [NSURL fileURLWithPath:self.rootPath];
            NSError *launchError = nil;
            if ([task launchAndReturnError:&launchError]) { self.backend = task; ownedBackendPid = task.processIdentifier; fprintf(stderr, "SIX backend launched: %d\n", task.processIdentifier); }
            else fprintf(stderr, "SIX backend could not start: %s\n", launchError.localizedDescription.UTF8String);
        });
    }] resume];
}

- (void)showMonitor {
    NSSize size = NSMakeSize(420, 390);
    NSArray<NSScreen *> *screens = NSScreen.screens;
    NSScreen *screen = screens.count > 1 ? screens[1] : NSScreen.mainScreen;
    NSRect bounds = screen.visibleFrame;
    NSRect rect = NSMakeRect(NSMidX(bounds) - size.width / 2, NSMidY(bounds) - size.height / 2, size.width, size.height);
    NSPanel *panel = [[NSPanel alloc] initWithContentRect:rect
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskNonactivatingPanel
        backing:NSBackingStoreBuffered defer:NO];
    panel.title = @"SIX";
    panel.floatingPanel = YES;
    panel.hidesOnDeactivate = NO;
    panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
    WKWebView *web = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, size.width, size.height)];
    self.web = web;
    panel.contentView = web;
    [panel orderFrontRegardless];
    self.panel = panel;
}

- (void)appActivated:(NSNotification *)notification {
    NSRunningApplication *app = notification.userInfo[NSWorkspaceApplicationKey];
    if (app.bundleIdentifier) { self.pendingBundle = app.bundleIdentifier; [self sendForeground]; }
}

- (void)sendForeground {
    [self ensureBackend];
    if (!self.pageLoaded) {
        NSMutableURLRequest *health = [NSMutableURLRequest requestWithURL:[self endpoint:@"api/health"]];
        health.timeoutInterval = 1;
        [[NSURLSession.sharedSession dataTaskWithRequest:health completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            if ([response isKindOfClass:NSHTTPURLResponse.class] && ((NSHTTPURLResponse *)response).statusCode == 200) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (!self.pageLoaded) {
                        self.pageLoaded = YES;
                        [self.web loadRequest:[NSURLRequest requestWithURL:[self endpoint:@"?popup=1&native=1"]]];
                    }
                });
            }
        }] resume];
    }
    NSString *bundle = self.pendingBundle;
    if (!bundle || [bundle isEqualToString:self.lastSentBundle]) return;
    [[NSURLSession.sharedSession dataTaskWithURL:[self endpoint:@"api/context"] completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (!data) return;
        NSDictionary *snapshot = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        NSString *token = [snapshot isKindOfClass:NSDictionary.class] ? snapshot[@"token"] : nil;
        if (![token isKindOfClass:NSString.class]) return;
        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[self endpoint:@"api/system/context"]];
        request.HTTPMethod = @"POST";
        [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
        [request setValue:token forHTTPHeaderField:@"X-Six-Token"];
        request.HTTPBody = [NSJSONSerialization dataWithJSONObject:@{@"bundle_id": bundle} options:0 error:nil];
        [[NSURLSession.sharedSession dataTaskWithRequest:request completionHandler:^(NSData *body, NSURLResponse *reply, NSError *postError) {
            if ([reply isKindOfClass:NSHTTPURLResponse.class] && ((NSHTTPURLResponse *)reply).statusCode == 200) {
                dispatch_async(dispatch_get_main_queue(), ^{ if ([self.pendingBundle isEqualToString:bundle]) self.lastSentBundle = bundle; });
            }
        }] resume];
    }] resume];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:self];
    [self.retryTimer invalidate];
    if (self.backend.isRunning) [self.backend terminate];
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        fprintf(stderr, "SIX host starting\n");
        signal(SIGTERM, stopHost);
        signal(SIGINT, stopHost);
        NSApplication *app = NSApplication.sharedApplication;
        static SixHost *hostDelegate;
        hostDelegate = [SixHost new];
        app.delegate = hostDelegate;
        [app run];
    }
    return 0;
}
