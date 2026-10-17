export const optimizeImage = (url) => {
    if (!url) return '';
    
    try {
        const hostname = new URL(url, 'http://dummy.local').hostname;
        if (hostname !== 'cloudinary.com' && !hostname.endsWith('.cloudinary.com')) {
            return url;
        }
    } catch (e) {
        // If it throws (e.g., a relative path like '/images/logo.png'), it's not a Cloudinary URL
        return url;
    }

    // Cloudinary URLs structure: .../image/upload/v1234567890/...
    // We want to inject the parameters right after /upload/
    const uploadSegment = '/upload/';
    const uploadIndex = url.indexOf(uploadSegment);
    
    if (uploadIndex !== -1) {
        const before = url.substring(0, uploadIndex + uploadSegment.length);
        const after = url.substring(uploadIndex + uploadSegment.length);
        return `${before}q_auto,f_auto/${after}`;
    }
    
    return url;
};