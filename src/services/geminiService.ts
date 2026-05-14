export async function getAiResponse(message: string, language: string, hasSentPhoto: boolean, history: { sender: string, content: string }[] = []) {
  try {
    const response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, language, hasSentPhoto, history })
    });
    
    if (!response.ok) {
      throw new Error('AI Service failed');
    }
    
    const data = await response.json();
    return data.text || "Thank you for your message! Our team is processing your request and will get back to you shortly. For urgent matters, please call 9881345984.";
  } catch (error) {
    console.error("Gemini Service Error:", error);
    return "Thank you for your message! Our team is processing your request and will get back to you shortly. For urgent matters, please call 9881345984.";
  }
}
