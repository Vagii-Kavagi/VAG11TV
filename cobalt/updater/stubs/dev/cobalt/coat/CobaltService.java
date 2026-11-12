package dev.cobalt.coat;

/** Compile-time stand-in for the engine's platform service base class; the real one is in the APK. */
public abstract class CobaltService {
    /** Makes the service when the page opens it by name through H5vccPlatformService. */
    public interface Factory {
        CobaltService createCobaltService(long nativeService);

        String getServiceName();
    }

    /** The answer to one message from the page. */
    public static class ResponseToClient {
        public boolean invalidState;
        public byte[] data;
    }

    protected boolean opened;

    public abstract void beforeStartOrResume();

    public abstract void beforeSuspend();

    public abstract void afterStopped();

    public abstract ResponseToClient receiveFromClient(byte[] data);

    public abstract void close();
}
