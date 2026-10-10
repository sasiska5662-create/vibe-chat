"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { MessageCircle, Send, LogOut, Plus, Search, X } from "lucide-react";

type Profile = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
};

type Chat = {
  id: string;
  is_group: boolean;
  name: string | null;
  other?: Profile;
};

type Message = {
  id: string;
  chat_id: string;
  sender_id: string;
  content: string;
  created_at: string;
};

export default function ChatsPage() {
  const router = useRouter();
  const supabase = createClient();

  const [me, setMe] = useState<Profile | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Profile[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // загрузка себя и чатов
  useEffect(() => {
    (async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        router.push("/");
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userData.user.id)
        .single();

      if (profile) setMe(profile);

      await loadChats(userData.user.id);
    })();
  }, []);

  async function loadChats(userId: string) {
    const { data: memberships } = await supabase
      .from("chat_members")
      .select("chat_id, chats(id, is_group, name)")
      .eq("user_id", userId);

    if (!memberships) return;

    const chatList: Chat[] = [];

    for (const m of memberships) {
      const chat = (m as any).chats;
      if (!chat) continue;

      // для личных чатов находим собеседника
      let other: Profile | undefined;
      if (!chat.is_group) {
        const { data: otherMember } = await supabase
          .from("chat_members")
          .select("profiles(id, username, display_name, avatar_url)")
          .eq("chat_id", chat.id)
          .neq("user_id", userId)
          .single();
        other = (otherMember as any)?.profiles ?? undefined;
      }

      chatList.push({ ...chat, other });
    }

    setChats(chatList);
  }

  // загрузка сообщений + realtime
  useEffect(() => {
    if (!activeChat) return;

    let channel: any = null;

    (async () => {
      const { data } = await supabase
        .from("messages")
        .select("*")
        .eq("chat_id", activeChat.id)
        .order("created_at", { ascending: true });

      setMessages(data ?? []);

      channel = supabase
        .channel(`chat-${activeChat.id}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
            filter: `chat_id=eq.${activeChat.id}`,
          },
          (payload) => {
            setMessages((prev) => [...prev, payload.new as Message]);
          }
        )
        .subscribe();
    })();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [activeChat]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || !activeChat || !me) return;

    const content = text.trim();
    setText("");

    await supabase.from("messages").insert({
      chat_id: activeChat.id,
      sender_id: me.id,
      content,
    });
  }

  // поиск пользователей
  async function searchUsers(q: string) {
    setSearchQuery(q);
    if (!q.trim() || !me) {
      setSearchResults([]);
      return;
    }

    const { data } = await supabase
      .from("profiles")
      .select("*")
      .ilike("username", `%${q}%`)
      .neq("id", me.id)
      .limit(10);

    setSearchResults(data ?? []);
  }

  // создать или открыть личный чат
  async function startChat(otherUser: Profile) {
    if (!me) return;

    // ищем существующий личный чат
    const { data: myChats } = await supabase
      .from("chat_members")
      .select("chat_id")
      .eq("user_id", me.id);

    const myChatIds = (myChats ?? []).map((c) => c.chat_id);

    if (myChatIds.length > 0) {
      const { data: shared } = await supabase
        .from("chat_members")
        .select("chat_id, chats!inner(is_group)")
        .eq("user_id", otherUser.id)
        .in("chat_id", myChatIds);

      const existing = (shared ?? []).find((s: any) => !s.chats.is_group);
      if (existing) {
        const chat = chats.find((c) => c.id === existing.chat_id);
        if (chat) {
          setActiveChat(chat);
          setSearchOpen(false);
          setSearchQuery("");
          setSearchResults([]);
          return;
        }
      }
    }

    // создаём новый чат
    const { data: newChat } = await supabase
      .from("chats")
      .insert({ is_group: false, created_by: me.id })
      .select()
      .single();

    if (!newChat) return;

    await supabase.from("chat_members").insert([
      { chat_id: newChat.id, user_id: me.id },
      { chat_id: newChat.id, user_id: otherUser.id },
    ]);

    const newChatObj: Chat = { ...newChat, other: otherUser };
    setChats((prev) => [...prev, newChatObj]);
    setActiveChat(newChatObj);
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
  }

  async function logout() {
    await supabase.auth.signOut();
    router.push("/");
  }

  function chatTitle(chat: Chat) {
    if (chat.is_group) return chat.name ?? "Группа";
    return chat.other?.display_name ?? "Чат";
  }

  function formatTime(iso: string) {
    const d = new Date(iso);
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  if (!me) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-neutral-500">Загрузка...</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-black text-white overflow-hidden">
      {/* Сайдбар */}
      <aside className="w-80 border-r border-neutral-800 flex flex-col bg-neutral-950">
        <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center">
              <MessageCircle className="w-5 h-5 text-white" />
            </div>
            <span className="font-semibold">Связь</span>
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => setSearchOpen(true)}
              className="p-2 hover:bg-neutral-800 rounded-lg transition"
              title="Найти пользователя"
            >
              <Plus className="w-5 h-5 text-neutral-400" />
            </button>
            <button
              onClick={logout}
              className="p-2 hover:bg-neutral-800 rounded-lg transition"
              title="Выйти"
            >
              <LogOut className="w-5 h-5 text-neutral-400" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {chats.length === 0 ? (
            <div className="p-6 text-center text-neutral-600 text-sm">
              Пока нет чатов.
              <br />
              Нажми <span className="text-blue-500">+</span> чтобы найти друга
            </div>
          ) : (
            chats.map((chat) => (
              <button
                key={chat.id}
                onClick={() => setActiveChat(chat)}
                className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-neutral-900 transition text-left ${
                  activeChat?.id === chat.id ? "bg-neutral-900" : ""
                }`}
              >
                <div className="w-12 h-12 rounded-full bg-neutral-800 flex items-center justify-center text-lg font-medium shrink-0">
                  {chatTitle(chat)[0]?.toUpperCase() ?? "?"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{chatTitle(chat)}</div>
                  <div className="text-xs text-neutral-500 truncate">
                    @{chat.other?.username ?? "группа"}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="p-3 border-t border-neutral-800 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-sm font-medium">
            {me.display_name[0]?.toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{me.display_name}</div>
            <div className="text-xs text-neutral-500 truncate">@{me.username}</div>
          </div>
        </div>
      </aside>

      {/* Основная область */}
      <main className="flex-1 flex flex-col">
        {!activeChat ? (
          <div className="flex-1 flex items-center justify-center text-neutral-600">
            <div className="text-center">
              <MessageCircle className="w-16 h-16 mx-auto mb-4 text-neutral-800" />
              <p>Выбери чат или создай новый</p>
            </div>
          </div>
        ) : (
          <>
            <div className="p-4 border-b border-neutral-800 flex items-center gap-3 bg-neutral-950">
              <div className="w-10 h-10 rounded-full bg-neutral-800 flex items-center justify-center font-medium">
                {chatTitle(activeChat)[0]?.toUpperCase()}
              </div>
              <div>
                <div className="font-medium">{chatTitle(activeChat)}</div>
                <div className="text-xs text-neutral-500">
                  @{activeChat.other?.username}
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {messages.map((m) => {
                const mine = m.sender_id === me.id;
                return (
                  <div
                    key={m.id}
                    className={`flex ${mine ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[70%] rounded-2xl px-4 py-2 ${
                        mine
                          ? "bg-blue-600 text-white"
                          : "bg-neutral-800 text-white"
                      }`}
                    >
                      <div className="whitespace-pre-wrap break-words">{m.content}</div>
                      <div
                        className={`text-[10px] mt-1 ${
                          mine ? "text-blue-200" : "text-neutral-400"
                        }`}
                      >
                        {formatTime(m.created_at)}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <form
              onSubmit={sendMessage}
              className="p-4 border-t border-neutral-800 flex gap-2 bg-neutral-950"
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Написать сообщение..."
                className="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-3 text-white placeholder-neutral-600 focus:outline-none focus:border-blue-600"
              />
              <button
                type="submit"
                disabled={!text.trim()}
                className="px-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl transition"
              >
                <Send className="w-5 h-5" />
              </button>
            </form>
          </>
        )}
      </main>

      {/* Модалка поиска */}
      {searchOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-start justify-center pt-24 z-50">
          <div className="w-full max-w-md bg-neutral-900 rounded-2xl border border-neutral-800 overflow-hidden">
            <div className="p-3 border-b border-neutral-800 flex items-center gap-2">
              <Search className="w-5 h-5 text-neutral-500" />
              <input
                autoFocus
                value={searchQuery}
                onChange={(e) => searchUsers(e.target.value)}
                placeholder="Поиск по @username"
                className="flex-1 bg-transparent outline-none text-white placeholder-neutral-600"
              />
              <button
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery("");
                  setSearchResults([]);
                }}
                className="p-1 hover:bg-neutral-800 rounded-lg"
              >
                <X className="w-5 h-5 text-neutral-400" />
              </button>
            </div>

            <div className="max-h-80 overflow-y-auto">
              {searchResults.length === 0 ? (
                <div className="p-6 text-center text-neutral-600 text-sm">
                  {searchQuery ? "Никого не нашли" : "Введи @username друга"}
                </div>
              ) : (
                searchResults.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => startChat(u)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-neutral-800 transition text-left"
                  >
                    <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center font-medium">
                      {u.display_name[0]?.toUpperCase()}
                    </div>
                    <div>
                      <div className="font-medium">{u.display_name}</div>
                      <div className="text-xs text-neutral-500">@{u.username}</div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}