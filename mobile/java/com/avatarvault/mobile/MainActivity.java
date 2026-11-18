package com.avatarvault.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Random;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public class MainActivity extends Activity {

    private static final String TAG = "AvatarVault";
    private static final int REQ_ASSET = 1001;
    private static final int REQ_IMAGE = 1002;
    private static final int REQ_EXPORT = 1003;

    private WebView web;
    private File vault;
    private File pendingExportZip;
    private String pendingImageItemId;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        vault = new File(getFilesDir(), "vault");
        ensureVault();

        web = new WebView(this);
        web.setBackgroundColor(0xFF0A0D11);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        web.setWebViewClient(new WebViewClient());
        // WebView 默认吞掉 alert/confirm，这里补一个原生对话框兜底
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView v, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("知道了", (d, w) -> result.confirm())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView v, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("确定", (d, w) -> result.confirm())
                        .setNegativeButton("取消", (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "AV");
        setContentView(web);
        web.loadUrl("file:///android_asset/app/index.html");
    }

    private void ensureVault() {
        try {
            if (!vault.exists()) vault.mkdirs();
            new File(vault, "orig").mkdirs();
            new File(vault, "prev").mkdirs();
            File idx = new File(vault, "index.json");
            if (!idx.exists()) {
                String empty = "{\"version\":1,\"items\":[],\"collections\":[]}";
                writeText(idx, empty);
            }
        } catch (Exception e) {
            Log.e(TAG, "ensureVault", e);
        }
    }

    /* ---------------- 文件工具 ---------------- */

    private static void writeText(File f, String text) throws IOException {
        FileOutputStream out = new FileOutputStream(f);
        try {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        } finally {
            out.close();
        }
    }

    private static String readText(File f) {
        try {
            byte[] b = new byte[(int) f.length()];
            FileInputStream in = new FileInputStream(f);
            try {
                int off = 0;
                while (off < b.length) {
                    int n = in.read(b, off, b.length - off);
                    if (n < 0) break;
                    off += n;
                }
            } finally {
                in.close();
            }
            return new String(b, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private static String safeName(String name) {
        String n = name == null ? "file" : name;
        n = n.replace("\\", "_").replace("/", "_").replace(":", "_");
        if (n.length() > 120) {
            int dot = n.lastIndexOf('.');
            String ext = dot > 0 ? n.substring(dot) : "";
            n = n.substring(0, Math.max(1, 100 - ext.length())) + ext;
        }
        return n.isEmpty() ? "file" : n;
    }

    private static String newId() {
        String t = Long.toString(System.currentTimeMillis(), 36);
        String r = Integer.toString(new Random().nextInt(1296), 36);
        while (r.length() < 2) r = "0" + r;
        return "m" + t + r;
    }

    private String displayName(Uri uri) {
        ContentResolver cr = getContentResolver();
        String name = null;
        try (Cursor c = cr.query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0) name = c.getString(i);
            }
        } catch (Exception ignored) { }
        if (name == null) {
            String last = uri.getLastPathSegment();
            name = last == null ? "file" : last.substring(last.lastIndexOf('/') + 1);
        }
        return safeName(name);
    }

    private File resolve(String rel) {
        // 只允许访问库内相对路径
        String clean = rel.replace('\\', '/');
        while (clean.startsWith("/")) clean = clean.substring(1);
        if (clean.contains("../")) return null;
        return new File(vault, clean);
    }

    /* ---------------- 选择文件 ---------------- */

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null) return;

        if (requestCode == REQ_ASSET) {
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                    uris.add(data.getClipData().getItemAt(i).getUri());
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            importAssets(uris);
        } else if (requestCode == REQ_IMAGE) {
            if (data.getData() != null && pendingImageItemId != null) {
                saveImage(pendingImageItemId, data.getData());
            }
            pendingImageItemId = null;
        } else if (requestCode == REQ_EXPORT) {
            if (data.getData() != null && pendingExportZip != null) {
                writeExport(data.getData(), pendingExportZip);
            }
        }
    }

    private void importAssets(final List<Uri> uris) {
        new Thread(() -> {
            JSONArray out = new JSONArray();
            for (Uri uri : uris) {
                String id = newId();
                String name = displayName(uri);
                File dir = new File(new File(vault, "orig"), id);
                dir.mkdirs();
                File dst = new File(dir, name);
                try (InputStream in = getContentResolver().openInputStream(uri);
                     OutputStream os = new FileOutputStream(dst)) {
                    if (in == null) throw new IOException("无法读取");
                    copy(in, os);
                    JSONObject o = new JSONObject();
                    o.put("id", id);
                    o.put("name", name);
                    o.put("relPath", "orig/" + id + "/" + name);
                    o.put("size", dst.length());
                    out.put(o);
                } catch (Exception e) {
                    Log.e(TAG, "import " + name, e);
                    try { deleteRec(dir); } catch (Exception ignored) { }
                }
            }
            final String json = out.toString();
            ui.post(() -> js("window.onAssetsPicked(" + json + ")"));
        }).start();
    }

    private void saveImage(final String itemId, final Uri uri) {
        new Thread(() -> {
            try {
                File dir = new File(new File(vault, "prev"), itemId);
                dir.mkdirs();
                InputStream in = getContentResolver().openInputStream(uri);
                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                BitmapFactory.decodeStream(in, null, bounds);
                if (in != null) in.close();

                int w = bounds.outWidth, h = bounds.outHeight;
                int sample = 1;
                while (w / sample > 1200 || h / sample > 1200) sample *= 2;

                BitmapFactory.Options opts = new BitmapFactory.Options();
                opts.inSampleSize = sample;
                in = getContentResolver().openInputStream(uri);
                Bitmap bmp = BitmapFactory.decodeStream(in, null, opts);
                if (in != null) in.close();
                if (bmp == null) return;

                String fname = "custom_" + System.currentTimeMillis() + ".jpg";
                File out = new File(dir, fname);
                FileOutputStream os = new FileOutputStream(out);
                bmp.compress(Bitmap.CompressFormat.JPEG, 86, os);
                os.close();
                bmp.recycle();
                ui.post(() -> js("window.onImageSaved(" + JSONObject.quote(itemId) + "," + JSONObject.quote(fname) + ")"));
            } catch (Exception e) {
                Log.e(TAG, "saveImage", e);
                ui.post(() -> toast("示意图保存失败"));
            }
        }).start();
    }

    /* ---------------- 导出备份 zip ---------------- */

    private void exportVault() {
        ui.post(() -> toast("打包中…"));
        new Thread(() -> {
            File dir = new File(getCacheDir(), "export");
            dir.mkdirs();
            String stamp = new SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(new Date());
            File zip = new File(dir, "AvatarVault手机库_" + stamp + ".zip");
            try (ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(zip))) {
                zos.setLevel(6);
                File idx = new File(vault, "index.json");
                zipFile(zos, idx, "index.json");
                for (String sub : new String[]{"orig", "prev"}) {
                    File d = new File(vault, sub);
                    File[] kids = d.listFiles();
                    if (kids == null) continue;
                    for (File kid : kids) {
                        if (!kid.isDirectory()) continue;
                        zipDir(zos, kid, sub + "/" + kid.getName());
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "export", e);
                ui.post(() -> toast("打包失败"));
                return;
            }
            final long size = zip.length();
            ui.post(() -> {
                pendingExportZip = zip;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/zip");
                i.putExtra(Intent.EXTRA_TITLE, zip.getName());
                startActivityForResult(i, REQ_EXPORT);
                toast("选保存位置（建议「下载」）");
            });
        }).start();
    }

    private void zipDir(ZipOutputStream zos, File dir, String prefix) throws IOException {
        File[] kids = dir.listFiles();
        if (kids == null) return;
        for (File f : kids) {
            String name = prefix + "/" + f.getName();
            if (f.isDirectory()) zipDir(zos, f, name);
            else zipFile(zos, f, name);
        }
    }

    private void zipFile(ZipOutputStream zos, File f, String name) throws IOException {
        zos.putNextEntry(new ZipEntry(name));
        try (InputStream in = new BufferedInputStream(new FileInputStream(f))) {
            copy(in, zos);
        }
        zos.closeEntry();
    }

    private void writeExport(Uri dest, File zip) {
        new Thread(() -> {
            try (InputStream in = new FileInputStream(zip);
                 OutputStream out = getContentResolver().openOutputStream(dest)) {
                if (out == null) throw new IOException("无法写入");
                copy(in, out);
                ui.post(() -> toast("已保存，传电脑用「导入备份」"));
            } catch (Exception e) {
                Log.e(TAG, "writeExport", e);
                ui.post(() -> toast("保存失败"));
            }
        }).start();
    }

    /* ---------------- 工具 ---------------- */

    private void js(String code) {
        if (web != null) web.evaluateJavascript(code, null);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    private static void deleteRec(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRec(k);
        }
        f.delete();
    }

    @Override
    public void onBackPressed() {
        // 交给页面处理（关详情面板 / 退出提示）
        js("window.onAndroidBack ? window.onAndroidBack() : false");
    }

    /* ---------------- JS 桥 ---------------- */

    class Bridge {

        @JavascriptInterface
        public String index() {
            File f = new File(vault, "index.json");
            String t = readText(f);
            return t == null ? "{\"version\":1,\"items\":[],\"collections\":[]}" : t;
        }

        @JavascriptInterface
        public boolean saveIndex(String json) {
            try {
                writeText(new File(vault, "index.json"), json);
                return true;
            } catch (Exception e) {
                Log.e(TAG, "saveIndex", e);
                return false;
            }
        }

        @JavascriptInterface
        public void pickAssets() {
            ui.post(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(i, REQ_ASSET);
                } catch (Exception e) {
                    toast("没有文件选择器");
                }
            });
        }

        @JavascriptInterface
        public void pickImage(String itemId) {
            pendingImageItemId = itemId;
            ui.post(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("image/*");
                startActivityForResult(i, REQ_IMAGE);
            });
        }

        @JavascriptInterface
        public String readChunk(String rel, long offset, int len) {
            File f = resolve(rel);
            if (f == null || !f.isFile()) return "";
            try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "r")) {
                long size = raf.length();
                if (offset >= size) return "";
                int want = (int) Math.min(len, size - offset);
                byte[] b = new byte[want];
                raf.seek(offset);
                raf.readFully(b);
                return Base64.encodeToString(b, Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String imageData(String rel) {
            File f = resolve(rel);
            if (f == null || !f.isFile()) return "";
            try {
                if (f.length() > 6L * 1024 * 1024) return "";
                byte[] b = new byte[(int) f.length()];
                FileInputStream in = new FileInputStream(f);
                try {
                    int off = 0;
                    while (off < b.length) {
                        int n = in.read(b, off, b.length - off);
                        if (n < 0) break;
                        off += n;
                    }
                } finally {
                    in.close();
                }
                String mime = f.getName().toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
                return "data:" + mime + ";base64," + Base64.encodeToString(b, Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String fileSize(String rel) {
            File f = resolve(rel);
            return f != null && f.isFile() ? String.valueOf(f.length()) : "0";
        }

        @JavascriptInterface
        public boolean deleteImage(String itemId, String fname) {
            File f = resolve("prev/" + itemId + "/" + fname);
            try {
                return f != null && f.isFile() && f.delete();
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean removeItem(String id) {
            try {
                deleteRec(new File(new File(vault, "orig"), id));
                deleteRec(new File(new File(vault, "prev"), id));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void exportVault() {
            MainActivity.this.exportVault();
        }

        @JavascriptInterface
        public void moveToBack() {
            ui.post(() -> moveTaskToBack(true));
        }

        @JavascriptInterface
        public void toastMsg(String msg) {
            ui.post(() -> toast(msg));
        }

        @JavascriptInterface
        public String vaultPath() {
            return vault.getAbsolutePath();
        }
    }
}
