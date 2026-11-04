package com.dsh.phoneaccess;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.File;

/** Records a short audio clip into the public Music folder, then exits. */
public class RecordActivity extends Activity {
    private static final String TAG = "DshRecord";
    private MediaRecorder recorder;
    private File output;
    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(0xFF101216);
        status = new TextView(this);
        status.setTextColor(0xFFFFFFFF);
        status.setTextSize(18);
        status.setGravity(Gravity.CENTER);
        root.addView(status);
        setContentView(root);

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            status.setText("正在申请录音权限…");
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, 1);
        } else {
            startRecording();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 1 && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startRecording();
        } else {
            status.setText("录音权限被拒绝");
        }
    }

    private void startRecording() {
        int seconds = Math.max(1, Math.min(30, getIntent().getIntExtra("seconds", 5)));
        try {
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC);
            if (!dir.exists()) dir.mkdirs();
            output = new File(dir, "DSH_REC_" + System.currentTimeMillis() + ".m4a");
            recorder = new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioEncodingBitRate(128000);
            recorder.setAudioSamplingRate(44100);
            recorder.setOutputFile(output.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            status.setText("正在录音 " + seconds + " 秒…\n" + output.getAbsolutePath());
            new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                @Override
                public void run() {
                    stopRecording();
                }
            }, seconds * 1000L);
        } catch (Throwable t) {
            Log.w(TAG, "record failed", t);
            status.setText("录音失败: " + t.getMessage());
            release();
        }
    }

    private void stopRecording() {
        try {
            release();
            if (output != null && output.exists()) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Audio.Media.DISPLAY_NAME, output.getName());
                values.put(MediaStore.Audio.Media.MIME_TYPE, "audio/mp4");
                values.put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_MUSIC);
                values.put(MediaStore.Audio.Media.IS_PENDING, 0);
                try {
                    getContentResolver().insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values);
                } catch (Throwable ignored) {
                }
                MediaScannerConnection.scanFile(this, new String[] { output.getAbsolutePath() }, new String[] { "audio/mp4" }, null);
                status.setText("录音完成\n" + output.getAbsolutePath());
            } else {
                status.setText("录音失败：没有生成文件");
            }
        } catch (Throwable t) {
            status.setText("保存失败: " + t.getMessage());
        }
        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
            @Override
            public void run() {
                finish();
            }
        }, 1200);
    }

    private void release() {
        if (recorder != null) {
            try { recorder.stop(); } catch (Throwable ignored) {}
            try { recorder.release(); } catch (Throwable ignored) {}
            recorder = null;
        }
    }

    @Override
    protected void onDestroy() {
        release();
        super.onDestroy();
    }
}
