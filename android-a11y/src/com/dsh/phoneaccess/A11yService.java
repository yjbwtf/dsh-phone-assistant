package com.dsh.phoneaccess;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.Notification;
import android.content.Intent;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.Parcelable;
import android.os.SystemClock;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * A small, self-contained accessibility bridge.
 *
 * It listens on 127.0.0.1:27183 and speaks one JSON object per line.  The PC
 * side reaches it through `adb forward tcp:27183 tcp:27183`.
 */
public class A11yService extends AccessibilityService {
    private static final String TAG = "DshA11y";
    private static final int PORT = 27183;
    private static final int MAX_NODES = 4000;
    private static final int MAX_DEPTH = 60;
    public static volatile A11yService instance;

    private volatile boolean running;
    private ServerSocket server;
    private Thread acceptThread;
    private ExecutorService clients;
    private long startedAt;
    private final ArrayDeque<JSONObject> notificationLog = new ArrayDeque<JSONObject>();
    private final Object notificationLock = new Object();
    private long notificationSeq = 0;
    private volatile String lastPackage = "";
    private volatile String lastClass = "";

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        startedAt = System.currentTimeMillis();
        Log.i(TAG, "accessibility service connected");
        startServer();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) return;
        int type = event.getEventType();
        if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            CharSequence pkg = event.getPackageName();
            CharSequence cls = event.getClassName();
            if (pkg != null) lastPackage = pkg.toString();
            if (cls != null) lastClass = cls.toString();
            return;
        }
        if (type == AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED) {
            recordNotification(event);
        }
    }

    @Override
    public void onInterrupt() {
        Log.w(TAG, "accessibility service interrupted");
    }

    @Override
    public void onDestroy() {
        instance = null;
        stopServer();
        super.onDestroy();
    }

    private synchronized void startServer() {
        if (running) return;
        running = true;
        clients = Executors.newCachedThreadPool();
        acceptThread = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop();
            }
        }, "dsh-a11y-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    private synchronized void stopServer() {
        running = false;
        ServerSocket current = server;
        server = null;
        if (current != null) {
            try {
                current.close();
            } catch (Exception ignored) {
            }
        }
        if (clients != null) {
            clients.shutdownNow();
            clients = null;
        }
    }

    private void acceptLoop() {
        while (running) {
            ServerSocket local = null;
            try {
                local = new ServerSocket();
                local.setReuseAddress(true);
                local.bind(new InetSocketAddress("127.0.0.1", PORT));
                server = local;
                Log.i(TAG, "listening on 127.0.0.1:" + PORT);
                while (running) {
                    final Socket socket = local.accept();
                    ExecutorService pool = clients;
                    if (pool == null) {
                        closeQuietly(socket);
                        break;
                    }
                    pool.execute(new Runnable() {
                        @Override
                        public void run() {
                            serve(socket);
                        }
                    });
                }
            } catch (Exception e) {
                if (running) {
                    Log.w(TAG, "server error: " + e);
                }
                closeQuietly(local);
                try {
                    Thread.sleep(800);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    private void serve(Socket socket) {
        try {
            socket.setTcpNoDelay(true);
            socket.setSoTimeout(0);
            BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            BufferedWriter out = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
            String line;
            while ((line = in.readLine()) != null) {
                if (line.length() > 4 * 1024 * 1024) {
                    JSONObject tooBig = new JSONObject();
                    tooBig.put("ok", false);
                    tooBig.put("error", "request too large");
                    out.write(tooBig.toString());
                    out.write("\n");
                    out.flush();
                    break;
                }
                JSONObject response;
                try {
                    response = handleLine(line);
                } catch (Throwable t) {
                    response = new JSONObject();
                    response.put("ok", false);
                    response.put("error", t.toString());
                    Log.w(TAG, "handler failure", t);
                }
                out.write(response.toString());
                out.write("\n");
                out.flush();
            }
        } catch (SocketException ignored) {
        } catch (Exception e) {
            Log.w(TAG, "client error: " + e);
        } finally {
            closeQuietly(socket);
        }
    }

    private JSONObject handleLine(String line) throws Exception {
        JSONObject req = new JSONObject(line);
        JSONObject response = new JSONObject();
        response.put("ok", false);
        response.put("id", req.opt("id"));
        try {
            String cmd = req.optString("cmd", "");
            Object data;
            if ("ping".equals(cmd)) {
                data = pingData();
            } else if ("status".equals(cmd)) {
                data = pingData();
            } else if ("dump".equals(cmd)) {
                data = dumpData();
            } else if ("windows".equals(cmd)) {
                data = windowsData();
            } else if ("notifications".equals(cmd)) {
                data = notificationsData();
            } else if ("wait_notification".equals(cmd)) {
                data = waitNotificationData(req);
            } else if ("clear_notifications".equals(cmd)) {
                data = clearNotificationsData();
            } else if ("inject_notification".equals(cmd)) {
                data = injectNotificationData(req);
            } else if ("foreground".equals(cmd)) {
                data = foregroundData();
            } else if ("find".equals(cmd)) {
                data = findData(req);
            } else if ("click".equals(cmd)) {
                data = clickData(req);
            } else if ("click_xy".equals(cmd) || "tap".equals(cmd)) {
                data = tapData(req.optInt("x"), req.optInt("y"), Math.max(1, req.optInt("durationMs", 60)));
            } else if ("long_press".equals(cmd)) {
                data = tapData(req.optInt("x"), req.optInt("y"), Math.max(400, req.optInt("durationMs", 700)));
            } else if ("swipe".equals(cmd)) {
                data = swipeData(req.optInt("x1"), req.optInt("y1"), req.optInt("x2"), req.optInt("y2"), Math.max(50, req.optInt("durationMs", 300)));
            } else if ("set_text".equals(cmd) || "input_text".equals(cmd)) {
                data = setTextData(req);
            } else if ("focus_input".equals(cmd)) {
                data = focusInputData();
            } else if ("global".equals(cmd)) {
                data = globalData(req.optString("action", "back"));
            } else if ("scroll".equals(cmd)) {
                data = scrollData(req.optString("direction", "forward"), req.optJSONObject("query"));
            } else {
                throw new IllegalArgumentException("unknown cmd: " + cmd);
            }
            response.put("ok", true);
            response.put("data", data);
        } catch (Throwable t) {
            response.put("ok", false);
            response.put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
        }
        return response;
    }

    private JSONObject pingData() throws Exception {
        JSONObject data = new JSONObject();
        data.put("service", true);
        data.put("version", 2);
        data.put("package", getPackageName());
        data.put("startedAt", startedAt);
        data.put("now", System.currentTimeMillis());
        data.put("lastPackage", lastPackage);
        data.put("lastClass", lastClass);
        synchronized (notificationLock) {
            data.put("notificationCount", notificationLog.size());
            data.put("latestNotificationSeq", notificationSeq);
        }
        JSONObject screen = new JSONObject();
        screen.put("width", getResources().getDisplayMetrics().widthPixels);
        screen.put("height", getResources().getDisplayMetrics().heightPixels);
        screen.put("density", getResources().getDisplayMetrics().density);
        data.put("screen", screen);
        return data;
    }

    private JSONObject foregroundData() throws Exception {
        JSONObject data = new JSONObject();
        data.put("package", lastPackage);
        data.put("class", lastClass);
        AccessibilityNodeInfo active = getRootInActiveWindow();
        data.put("activePackage", active == null ? "" : safe(active.getPackageName()));
        data.put("activeClass", active == null ? "" : safe(active.getClassName()));
        return data;
    }

    private JSONObject notificationsData() throws Exception {
        JSONObject data = new JSONObject();
        JSONArray items = new JSONArray();
        synchronized (notificationLock) {
            for (JSONObject item : notificationLog) items.put(item);
            data.put("latestSeq", notificationSeq);
        }
        data.put("items", items);
        return data;
    }

    private JSONObject clearNotificationsData() throws Exception {
        synchronized (notificationLock) {
            notificationLog.clear();
        }
        JSONObject data = new JSONObject();
        data.put("cleared", true);
        return data;
    }

    private JSONObject waitNotificationData(JSONObject req) throws Exception {
        long after = req.has("afterSeq") ? req.optLong("afterSeq", -1) : -1;
        long timeoutMs = Math.max(1000, Math.min(60000, req.optLong("timeoutMs", 20000)));
        long deadline = System.currentTimeMillis() + timeoutMs;
        JSONArray items = new JSONArray();
        synchronized (notificationLock) {
            if (after < 0) after = notificationSeq;
            while (true) {
                for (JSONObject item : notificationLog) {
                    if (item.optLong("seq", 0) > after) items.put(item);
                }
                if (items.length() > 0) break;
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) break;
                notificationLock.wait(Math.min(remaining, 1000));
            }
            if (items.length() == 0) {
                // Return the latest entries on timeout so a caller can still inspect them.
                int skip = Math.max(0, notificationLog.size() - 5);
                int index = 0;
                for (JSONObject item : notificationLog) {
                    if (index++ >= skip) items.put(item);
                }
            }
        }
        JSONObject data = new JSONObject();
        data.put("items", items);
        data.put("afterSeq", after);
        data.put("timedOut", items.length() == 0);
        return data;
    }

    private JSONObject dumpData() throws Exception {
        JSONObject data = new JSONObject();
        AccessibilityNodeInfo active = getRootInActiveWindow();
        data.put("package", active == null ? "" : safe(active.getPackageName()));
        data.put("class", active == null ? "" : safe(active.getClassName()));
        data.put("activeRootAvailable", active != null);
        int[] counter = new int[] { 0 };
        boolean[] truncated = new boolean[] { false };
        data.put("root", active == null ? JSONObject.NULL : dumpNode(active, "0", 0, counter, truncated));
        data.put("nodeCount", counter[0]);
        data.put("truncated", truncated[0]);
        data.put("windows", windowsArray());
        data.put("screen", screenObject());
        return data;
    }

    private JSONObject windowsData() throws Exception {
        JSONObject data = new JSONObject();
        data.put("windows", windowsArray());
        data.put("screen", screenObject());
        AccessibilityNodeInfo active = getRootInActiveWindow();
        data.put("package", active == null ? "" : safe(active.getPackageName()));
        data.put("class", active == null ? "" : safe(active.getClassName()));
        return data;
    }

    private JSONArray windowsArray() {
        JSONArray array = new JSONArray();
        try {
            List<AccessibilityWindowInfo> windows = getWindows();
            if (windows == null) return array;
            for (AccessibilityWindowInfo window : windows) {
                if (window == null) continue;
                JSONObject item = new JSONObject();
                item.put("id", window.getId());
                item.put("type", window.getType());
                item.put("layer", window.getLayer());
                item.put("active", window.isActive());
                item.put("focused", window.isFocused());
                item.put("accessibilityFocused", window.isAccessibilityFocused());
                Rect bounds = new Rect();
                window.getBoundsInScreen(bounds);
                item.put("bounds", boundsArray(bounds));
                AccessibilityNodeInfo root = window.getRoot();
                if (root != null) {
                    item.put("package", safe(root.getPackageName()));
                    item.put("class", safe(root.getClassName()));
                    item.put("rootAvailable", true);
                    item.put("childCount", root.getChildCount());
                } else {
                    item.put("rootAvailable", false);
                }
                array.put(item);
            }
        } catch (Throwable t) {
            Log.w(TAG, "windows failure: " + t);
        }
        return array;
    }

    private JSONObject screenObject() throws Exception {
        JSONObject screen = new JSONObject();
        screen.put("width", getResources().getDisplayMetrics().widthPixels);
        screen.put("height", getResources().getDisplayMetrics().heightPixels);
        screen.put("density", getResources().getDisplayMetrics().density);
        return screen;
    }

    private JSONObject dumpNode(AccessibilityNodeInfo node, String path, int depth, int[] counter, boolean[] truncated) {
        counter[0]++;
        if (counter[0] > MAX_NODES) {
            truncated[0] = true;
            return summaryNode(node, path);
        }
        JSONObject item = summaryNode(node, path);
        try {
            item.put("childCount", node.getChildCount());
            if (depth < MAX_DEPTH && node.getChildCount() > 0) {
                JSONArray children = new JSONArray();
                for (int i = 0; i < node.getChildCount(); i++) {
                    AccessibilityNodeInfo child = node.getChild(i);
                    if (child == null) continue;
                    children.put(dumpNode(child, path + "/" + i, depth + 1, counter, truncated));
                }
                item.put("children", children);
            }
        } catch (Throwable t) {
            Log.w(TAG, "node dump failure", t);
        }
        return item;
    }

    private JSONObject summaryNode(AccessibilityNodeInfo node, String path) {
        JSONObject item = new JSONObject();
        try {
            item.put("path", path);
            item.put("text", safe(node.getText()));
            item.put("desc", safe(node.getContentDescription()));
            item.put("id", safe(node.getViewIdResourceName()));
            item.put("cls", safe(node.getClassName()));
            item.put("pkg", safe(node.getPackageName()));
            Rect bounds = new Rect();
            node.getBoundsInScreen(bounds);
            item.put("bounds", boundsArray(bounds));
            item.put("center", centerArray(bounds));
            item.put("clickable", node.isClickable());
            item.put("longClickable", node.isLongClickable());
            item.put("editable", node.isEditable());
            item.put("focusable", node.isFocusable());
            item.put("focused", node.isFocused());
            item.put("scrollable", node.isScrollable());
            item.put("selected", node.isSelected());
            item.put("checked", node.isChecked());
            item.put("enabled", node.isEnabled());
            item.put("password", node.isPassword());
            item.put("visible", node.isVisibleToUser());
            item.put("actions", actionNames(node));
        } catch (Throwable t) {
            Log.w(TAG, "node summary failure", t);
        }
        return item;
    }

    private JSONArray actionNames(AccessibilityNodeInfo node) {
        JSONArray names = new JSONArray();
        try {
            List<AccessibilityNodeInfo.AccessibilityAction> actions = node.getActionList();
            for (AccessibilityNodeInfo.AccessibilityAction action : actions) {
                CharSequence label = action.getLabel();
                if (label != null && label.length() > 0) {
                    names.put(label.toString());
                } else {
                    int id = action.getId();
                    if (id == AccessibilityNodeInfo.ACTION_CLICK) names.put("click");
                    else if (id == AccessibilityNodeInfo.ACTION_LONG_CLICK) names.put("long_click");
                    else if (id == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD) names.put("scroll_forward");
                    else if (id == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD) names.put("scroll_backward");
                    else if (id == AccessibilityNodeInfo.ACTION_SET_TEXT) names.put("set_text");
                    else if (id == AccessibilityNodeInfo.ACTION_FOCUS) names.put("focus");
                }
            }
        } catch (Throwable ignored) {
        }
        return names;
    }

    private void recordNotification(AccessibilityEvent event) {
        JSONObject item = new JSONObject();
        try {
            item.put("time", System.currentTimeMillis());
            item.put("package", safe(event.getPackageName()));
            item.put("className", safe(event.getClassName()));
            item.put("contentDescription", safe(event.getContentDescription()));
            JSONArray eventText = new JSONArray();
            List<CharSequence> texts = event.getText();
            if (texts != null) {
                for (CharSequence text : texts) eventText.put(safe(text));
            }
            item.put("eventText", eventText);
            Parcelable parcelable = event.getParcelableData();
            if (parcelable instanceof Notification) {
                Notification notification = (Notification) parcelable;
                Bundle extras = notification.extras;
                item.put("title", extras == null ? "" : safe(extras.getCharSequence(Notification.EXTRA_TITLE)));
                item.put("text", extras == null ? "" : safe(extras.getCharSequence(Notification.EXTRA_TEXT)));
                item.put("bigText", extras == null ? "" : safe(extras.getCharSequence(Notification.EXTRA_BIG_TEXT)));
                item.put("subText", extras == null ? "" : safe(extras.getCharSequence(Notification.EXTRA_SUB_TEXT)));
                item.put("infoText", extras == null ? "" : safe(extras.getCharSequence(Notification.EXTRA_INFO_TEXT)));
                item.put("ticker", safe(notification.tickerText));
                item.put("when", notification.when);
                item.put("number", notification.number);
                if (extras != null) {
                    CharSequence[] lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
                    JSONArray lineArray = new JSONArray();
                    if (lines != null) for (CharSequence line : lines) lineArray.put(safe(line));
                    item.put("textLines", lineArray);

                    Parcelable[] messages = extras.getParcelableArray(Notification.EXTRA_MESSAGES);
                    JSONArray messageArray = new JSONArray();
                    if (messages != null) {
                        for (Parcelable message : messages) {
                            if (!(message instanceof Bundle)) continue;
                            Bundle bundle = (Bundle) message;
                            JSONObject entry = new JSONObject();
                            entry.put("text", safe(bundle.getCharSequence("text")));
                            entry.put("sender", safe(bundle.getCharSequence("sender")));
                            entry.put("time", bundle.getLong("time", 0));
                            messageArray.put(entry);
                        }
                    }
                    item.put("messages", messageArray);
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "notification capture failure", t);
        }
        appendNotification(item);
        Log.i(TAG, "notification from " + item.optString("package") + " title=" + item.optString("title"));
    }

    private JSONObject injectNotificationData(JSONObject req) throws Exception {
        JSONObject item = new JSONObject();
        item.put("time", req.optLong("time", System.currentTimeMillis()));
        item.put("package", req.optString("package", "com.tencent.mm"));
        item.put("className", "android.app.Notification");
        item.put("contentDescription", "");
        item.put("title", req.optString("title", ""));
        item.put("text", req.optString("text", ""));
        item.put("bigText", req.optString("bigText", ""));
        item.put("subText", "");
        item.put("infoText", "");
        item.put("ticker", req.optString("text", ""));
        item.put("when", System.currentTimeMillis());
        item.put("number", 0);
        item.put("textLines", new JSONArray());
        item.put("messages", new JSONArray());
        appendNotification(item);
        return item;
    }

    private void appendNotification(JSONObject item) {
        synchronized (notificationLock) {
            try {
                item.put("seq", ++notificationSeq);
            } catch (Exception ignored) {
            }
            notificationLog.addLast(item);
            while (notificationLog.size() > 120) notificationLog.removeFirst();
            notificationLock.notifyAll();
        }
    }

    private JSONObject findData(JSONObject req) throws Exception {
        JSONObject query = req.optJSONObject("query");
        boolean all = req.optBoolean("all", false);
        List<NodeRef> refs = findNodes(query, all);
        JSONArray items = new JSONArray();
        int limit = Math.max(1, Math.min(200, req.optInt("limit", 60)));
        for (int i = 0; i < refs.size() && i < limit; i++) {
            NodeRef ref = refs.get(i);
            JSONObject item = summaryNode(ref.node, ref.path);
            item.put("windowId", ref.windowId);
            items.put(item);
        }
        JSONObject data = new JSONObject();
        data.put("items", items);
        data.put("count", refs.size());
        data.put("limit", limit);
        data.put("activePackage", activePackage());
        return data;
    }

    private JSONObject clickData(JSONObject req) throws Exception {
        JSONObject query = req.optJSONObject("query");
        NodeRef ref = null;
        if (query != null && query.length() > 0) {
            List<NodeRef> refs = findNodes(query, req.optBoolean("all", false));
            if (refs.isEmpty()) throw new IllegalStateException("no matching node");
            ref = refs.get(0);
        } else if (req.has("path")) {
            ref = resolvePath(req.optInt("windowId", -1), req.optString("path", ""));
        }
        if (ref == null) throw new IllegalArgumentException("click needs query or path");
        AccessibilityNodeInfo target = ref.node;
        AccessibilityNodeInfo clickable = target;
        for (int i = 0; i < 6 && clickable != null && !clickable.isClickable(); i++) {
            clickable = clickable.getParent();
        }
        boolean viaNode = false;
        if (clickable != null && clickable.isClickable()) {
            viaNode = clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        }
        JSONObject data = new JSONObject();
        if (!viaNode) {
            Rect bounds = new Rect();
            target.getBoundsInScreen(bounds);
            if (bounds.width() <= 0 || bounds.height() <= 0) throw new IllegalStateException("node has empty bounds");
            tap(bounds.centerX(), bounds.centerY(), 60);
            data.put("via", "gesture");
        } else {
            data.put("via", "node");
        }
        data.put("clicked", true);
        data.put("path", ref.path);
        data.put("windowId", ref.windowId);
        data.put("text", safe(target.getText()));
        data.put("desc", safe(target.getContentDescription()));
        Thread.sleep(Math.max(0, Math.min(2000, req.optInt("waitMs", 350))));
        return data;
    }

    private JSONObject tapData(int x, int y, int durationMs) throws Exception {
        boolean ok = tap(x, y, durationMs);
        JSONObject data = new JSONObject();
        data.put("tapped", ok);
        data.put("x", x);
        data.put("y", y);
        if (!ok) throw new IllegalStateException("gesture dispatch failed");
        return data;
    }

    private JSONObject swipeData(int x1, int y1, int x2, int y2, int durationMs) throws Exception {
        Path path = new Path();
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);
        GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, durationMs);
        GestureDescription gesture = new GestureDescription.Builder().addStroke(stroke).build();
        boolean ok = dispatch(gesture);
        JSONObject data = new JSONObject();
        data.put("swiped", ok);
        data.put("from", new JSONArray().put(x1).put(y1));
        data.put("to", new JSONArray().put(x2).put(y2));
        if (!ok) throw new IllegalStateException("gesture dispatch failed");
        return data;
    }

    private JSONObject setTextData(JSONObject req) throws Exception {
        String text = req.optString("text", "");
        JSONObject query = req.optJSONObject("query");
        AccessibilityNodeInfo target = null;
        String path = "";
        int windowId = -1;
        if (query != null && query.length() > 0) {
            List<NodeRef> refs = findNodes(query, false);
            for (NodeRef ref : refs) {
                if (ref.node.isEditable()) {
                    target = ref.node;
                    path = ref.path;
                    windowId = ref.windowId;
                    break;
                }
            }
            if (target == null && !refs.isEmpty()) {
                target = refs.get(0).node;
                path = refs.get(0).path;
                windowId = refs.get(0).windowId;
            }
        } else if (req.has("path")) {
            NodeRef ref = resolvePath(req.optInt("windowId", -1), req.optString("path", ""));
            target = ref.node;
            path = ref.path;
            windowId = ref.windowId;
        } else {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            NodeRef found = findEditable(root, "0");
            if (found != null) {
                target = found.node;
                path = found.path;
            }
        }
        if (target == null) throw new IllegalStateException("no editable/focused input found");
        boolean focused = target.isFocused();
        if (!focused) {
            target.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            target.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            Thread.sleep(180);
        }
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        if (!ok) {
            target.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            Thread.sleep(120);
            ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        }
        JSONObject data = new JSONObject();
        data.put("set", ok);
        data.put("length", text.length());
        data.put("path", path);
        data.put("windowId", windowId);
        data.put("focused", target.isFocused());
        if (!ok) throw new IllegalStateException("ACTION_SET_TEXT rejected");
        return data;
    }

    private JSONObject focusInputData() throws Exception {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        NodeRef found = findEditable(root, "0");
        if (found == null) throw new IllegalStateException("no editable node");
        found.node.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        found.node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        JSONObject data = new JSONObject();
        data.put("focused", found.node.isFocused());
        data.put("path", found.path);
        data.put("hint", safe(found.node.getHintText()));
        return data;
    }

    private JSONObject globalData(String action) throws Exception {
        int code;
        if ("back".equals(action)) code = GLOBAL_ACTION_BACK;
        else if ("home".equals(action)) code = GLOBAL_ACTION_HOME;
        else if ("recents".equals(action)) code = GLOBAL_ACTION_RECENTS;
        else if ("notifications".equals(action)) code = GLOBAL_ACTION_NOTIFICATIONS;
        else if ("quicksettings".equals(action)) code = GLOBAL_ACTION_QUICK_SETTINGS;
        else throw new IllegalArgumentException("unknown global action: " + action);
        boolean ok = performGlobalAction(code);
        JSONObject data = new JSONObject();
        data.put("performed", ok);
        data.put("action", action);
        return data;
    }

    private JSONObject scrollData(String direction, JSONObject query) throws Exception {
        AccessibilityNodeInfo target = null;
        if (query != null && query.length() > 0) {
            List<NodeRef> refs = findNodes(query, false);
            for (NodeRef ref : refs) {
                if (ref.node.isScrollable()) {
                    target = ref.node;
                    break;
                }
            }
            if (target == null && !refs.isEmpty()) target = refs.get(0).node;
        }
        if (target == null) target = findScrollable(getRootInActiveWindow());
        if (target == null) throw new IllegalStateException("no scrollable node");
        int action = "backward".equals(direction)
                ? AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                : AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
        boolean ok = target.performAction(action);
        JSONObject data = new JSONObject();
        data.put("scrolled", ok);
        data.put("direction", direction);
        data.put("class", safe(target.getClassName()));
        if (!ok) throw new IllegalStateException("scroll action rejected");
        return data;
    }

    private AccessibilityNodeInfo findScrollable(AccessibilityNodeInfo root) {
        if (root == null) return null;
        if (root.isScrollable() && root.isVisibleToUser()) return root;
        for (int i = 0; i < root.getChildCount(); i++) {
            AccessibilityNodeInfo found = findScrollable(root.getChild(i));
            if (found != null) return found;
        }
        return null;
    }

    private NodeRef findEditable(AccessibilityNodeInfo node, String path) {
        if (node == null) return null;
        if (node.isEditable() && node.isVisibleToUser()) {
            return new NodeRef(node, -1, path);
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            NodeRef found = findEditable(node.getChild(i), path + "/" + i);
            if (found != null) return found;
        }
        return null;
    }

    private List<NodeRef> findNodes(JSONObject query, boolean allWindows) {
        List<NodeRef> refs = new ArrayList<NodeRef>();
        if (allWindows) {
            try {
                List<AccessibilityWindowInfo> windows = getWindows();
                if (windows != null) {
                    for (AccessibilityWindowInfo window : windows) {
                        if (window == null) continue;
                        AccessibilityNodeInfo root = window.getRoot();
                        if (root != null) collect(root, "0", window.getId(), query, refs);
                    }
                }
            } catch (Throwable ignored) {
            }
        } else {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null) collect(root, "0", -1, query, refs);
        }
        return refs;
    }

    private void collect(AccessibilityNodeInfo node, String path, int windowId, JSONObject query, List<NodeRef> out) {
        if (node == null) return;
        if (matches(node, query)) out.add(new NodeRef(node, windowId, path));
        for (int i = 0; i < node.getChildCount(); i++) {
            collect(node.getChild(i), path + "/" + i, windowId, query, out);
        }
    }

    private boolean matches(AccessibilityNodeInfo node, JSONObject query) {
        if (query == null) return true;
        boolean includeInvisible = query.optBoolean("includeInvisible", false);
        if (!includeInvisible && !node.isVisibleToUser()) return false;
        boolean exact = query.optBoolean("exact", false);
        if (query.has("text") && !matchText(safe(node.getText()), query.optString("text", ""), exact)) return false;
        if (query.has("desc") && !matchText(safe(node.getContentDescription()), query.optString("desc", ""), exact)) return false;
        if (query.has("id") && !matchText(safe(node.getViewIdResourceName()), query.optString("id", ""), exact)) return false;
        if (query.has("cls") && !matchText(safe(node.getClassName()), query.optString("cls", ""), exact)) return false;
        if (query.has("clickable") && node.isClickable() != query.optBoolean("clickable", false)) return false;
        if (query.has("editable") && node.isEditable() != query.optBoolean("editable", false)) return false;
        if (query.has("focused") && node.isFocused() != query.optBoolean("focused", false)) return false;
        return true;
    }

    private boolean matchText(String actual, String expected, boolean exact) {
        if (actual == null) actual = "";
        if (expected == null) expected = "";
        return exact ? actual.equals(expected) : actual.contains(expected);
    }

    private NodeRef resolvePath(int windowId, String path) {
        AccessibilityNodeInfo root;
        if (windowId < 0) {
            root = getRootInActiveWindow();
        } else {
            root = rootForWindow(windowId);
        }
        if (root == null) throw new IllegalStateException("no root for window " + windowId);
        if (path == null || path.length() == 0 || "0".equals(path)) return new NodeRef(root, windowId, "0");
        String[] parts = path.split("/");
        AccessibilityNodeInfo current = root;
        for (int i = 1; i < parts.length; i++) {
            int index;
            try {
                index = Integer.parseInt(parts[i]);
            } catch (NumberFormatException e) {
                throw new IllegalArgumentException("bad path: " + path);
            }
            current = current.getChild(index);
            if (current == null) throw new IllegalStateException("path not found: " + path);
        }
        return new NodeRef(current, windowId, path);
    }

    private AccessibilityNodeInfo rootForWindow(int windowId) {
        try {
            List<AccessibilityWindowInfo> windows = getWindows();
            if (windows != null) {
                for (AccessibilityWindowInfo window : windows) {
                    if (window != null && window.getId() == windowId) return window.getRoot();
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    private boolean tap(int x, int y, int durationMs) throws Exception {
        Path path = new Path();
        path.moveTo(x, y);
        path.lineTo(x + 1, y + 1);
        GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, durationMs);
        GestureDescription gesture = new GestureDescription.Builder().addStroke(stroke).build();
        return dispatch(gesture);
    }

    private boolean dispatch(GestureDescription gesture) throws Exception {
        final CountDownLatch latch = new CountDownLatch(1);
        final boolean[] result = new boolean[] { false };
        boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription gestureDescription) {
                result[0] = true;
                latch.countDown();
            }

            @Override
            public void onCancelled(GestureDescription gestureDescription) {
                result[0] = false;
                latch.countDown();
            }
        }, null);
        if (!accepted) return false;
        latch.await(3, TimeUnit.SECONDS);
        SystemClock.sleep(40);
        return result[0];
    }

    private String activePackage() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        String value = root == null ? "" : safe(root.getPackageName());
        return value.length() == 0 ? lastPackage : value;
    }

    private static JSONArray boundsArray(Rect rect) {
        JSONArray array = new JSONArray();
        array.put(rect.left);
        array.put(rect.top);
        array.put(rect.right);
        array.put(rect.bottom);
        return array;
    }

    private static JSONArray centerArray(Rect rect) {
        JSONArray array = new JSONArray();
        array.put(rect.centerX());
        array.put(rect.centerY());
        return array;
    }

    private static String safe(CharSequence value) {
        return value == null ? "" : value.toString();
    }

    private static void closeQuietly(ServerSocket socket) {
        if (socket == null) return;
        try {
            socket.close();
        } catch (Exception ignored) {
        }
    }

    private static void closeQuietly(Socket socket) {
        if (socket == null) return;
        try {
            socket.close();
        } catch (Exception ignored) {
        }
    }

    private static final class NodeRef {
        final AccessibilityNodeInfo node;
        final int windowId;
        final String path;

        NodeRef(AccessibilityNodeInfo node, int windowId, String path) {
            this.node = node;
            this.windowId = windowId;
            this.path = path;
        }
    }
}
